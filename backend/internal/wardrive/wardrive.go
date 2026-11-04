// Package wardrive accepts MeshMapper "Custom API" coverage pings (issue #114).
//
// The MeshMapper app POSTs {"data":[ping,...]} (1-50 pings) with an X-API-Key
// header and never retries; any 4xx is shown to the driver as an error. So the
// handler answers 2xx for anything structurally valid and silently drops pings
// it can't use (unknown type, bad coordinates, stale timestamp). Plausibility
// against known repeaters happens on the read side (store.Coverage), where the
// node registry lives.
//
// There are no accounts: the endpoint is open unless an instance-wide
// sharedKey is configured, and abuse is bounded by a per-IP rate limit.
package wardrive

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/litescope/backend/internal/db"
)

const (
	maxBodyBytes   = 128 << 10
	maxBatchItems  = 50
	maxFutureSkew  = 5 * time.Minute
	// MeshMapper posts every 5-15 s per driver; mobile carriers put many users
	// behind one CGNAT address, so the per-IP budget leaves room for a few
	// dozen concurrent drivers while still stopping floods.
	rateBurst      = 20.0
	ratePerSecond  = 2.0
	limiterIdleTTL = 10 * time.Minute
)

// Store is the persistence the handler needs (satisfied by *db.DB).
type Store interface {
	InsertWardriveBatch([]*db.WardriveSample) (int, error)
}

// Options configures a Handler.
type Options struct {
	SharedKey      string
	MaxPingAge     time.Duration
	Salt           string
	TrustedProxies []string
	Now            func() time.Time // test hook; defaults to time.Now
}

// Handler serves POST /api/wardrive.
type Handler struct {
	store   Store
	opt     Options
	trusted []*net.IPNet
	limiter *limiter
}

// NewHandler builds a Handler. Invalid TrustedProxies entries are logged and skipped.
func NewHandler(st Store, opt Options) *Handler {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	h := &Handler{store: st, opt: opt, limiter: newLimiter(opt.Now)}
	for _, c := range opt.TrustedProxies {
		if !strings.Contains(c, "/") {
			if ip := net.ParseIP(c); ip != nil && ip.To4() != nil {
				c += "/32"
			} else {
				c += "/128"
			}
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			h.trusted = append(h.trusted, n)
		} else {
			log.Printf("wardrive: ignoring invalid trustedProxies entry %q", c)
		}
	}
	return h
}

// Response is the JSON body returned on success (MeshMapper ignores it).
type Response struct {
	Received int `json:"received"`
	Accepted int `json:"accepted"`
	Stored   int `json:"stored"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.opt.SharedKey != "" {
		got := r.Header.Get("X-API-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(h.opt.SharedKey)) != 1 {
			http.Error(w, "invalid API key", http.StatusUnauthorized)
			return
		}
	}
	if !h.limiter.allow(h.clientIP(r)) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	if len(body) > maxBodyBytes {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	var req struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if len(req.Data) > maxBatchItems {
		http.Error(w, "too many items", http.StatusRequestEntityTooLarge)
		return
	}

	now := h.opt.Now()
	samples := make([]*db.WardriveSample, 0, len(req.Data))
	for _, raw := range req.Data {
		var p ping
		if err := json.Unmarshal(raw, &p); err != nil {
			continue // one malformed item must not fail the batch
		}
		if s := h.convert(&p, now); s != nil {
			samples = append(samples, s)
		}
	}
	stored, err := h.store.InsertWardriveBatch(samples)
	if err != nil {
		log.Printf("wardrive: store %d samples: %v", len(samples), err)
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{Received: len(req.Data), Accepted: len(samples), Stored: stored}) //nolint:errcheck
}

// ping is the union of every MeshMapper ping type's fields.
type ping struct {
	Type         string   `json:"type"`
	Lat          *float64 `json:"lat"`
	Lon          *float64 `json:"lon"`
	Timestamp    *float64 `json:"timestamp"`
	NoiseFloor   *float64 `json:"noisefloor"`
	RadioFreq    string   `json:"radio_freq"`
	Contact      string   `json:"contact"`
	IATA         string   `json:"iata"`
	HeardRepeats string   `json:"heard_repeats"`
	RepeaterID   string   `json:"repeater_id"`
	LocalSNR     *float64 `json:"local_snr"`
	LocalRSSI    *float64 `json:"local_rssi"`
	RemoteSNR    *float64 `json:"remote_snr"`
}

func (h *Handler) convert(p *ping, now time.Time) *db.WardriveSample {
	typ := strings.ToUpper(strings.TrimSpace(p.Type))
	if p.Lat == nil || p.Lon == nil || p.Timestamp == nil {
		return nil
	}
	lat, lon := *p.Lat, *p.Lon
	if !validCoord(lat, lon) {
		return nil
	}
	ts := int64(*p.Timestamp)
	t := time.Unix(ts, 0)
	if t.After(now.Add(maxFutureSkew)) || (h.opt.MaxPingAge > 0 && t.Before(now.Add(-h.opt.MaxPingAge))) {
		return nil
	}

	s := &db.WardriveSample{
		TS: ts, Lat: lat, Lon: lon, Type: typ,
		IATA:       normalizeIATA(p.IATA),
		RadioFreq:  truncate(strings.TrimSpace(p.RadioFreq), 32),
		DeviceHash: h.deviceHash(p.Contact),
		ReceivedAt: now.Unix(),
	}
	if p.NoiseFloor != nil && *p.NoiseFloor > -200 && *p.NoiseFloor < 0 {
		nf := int(math.Round(*p.NoiseFloor))
		s.NoiseFloor = &nf
	}

	switch typ {
	case "TX":
		hears, none := parseHeardRepeats(p.HeardRepeats)
		switch {
		case none:
			s.Status = db.WardriveDead
		case len(hears) > 0:
			s.Status, s.Hears = db.WardriveHeard, hears
		default:
			return nil // malformed heard_repeats
		}
	case "RX":
		hears, _ := parseHeardRepeats(p.HeardRepeats)
		if len(hears) == 0 {
			return nil
		}
		s.Status, s.Hears = db.WardriveHeard, hears
	case "DISC", "TRACE":
		id := strings.ToUpper(strings.TrimSpace(p.RepeaterID))
		if id == "NONE" {
			if typ == "TRACE" {
				return nil // only answered traces are meaningful
			}
			s.Status = db.WardriveDead
			break
		}
		if !validPrefix(id) {
			return nil
		}
		s.Status = db.WardriveHeard
		s.Hears = []db.WardriveHear{{
			RepeaterPrefix: id,
			SNR:            snrPtr(p.LocalSNR),
			RSSI:           rssiPtr(p.LocalRSSI),
			RemoteSNR:      snrPtr(p.RemoteSNR),
		}}
	case "DEFER":
		s.Status = db.WardriveClaimed
	default:
		return nil // SCOPES and unknown future types: accepted, not stored
	}
	return s
}

// parseHeardRepeats parses "4E(12.25),77(8.50)" / "4E(null)" / "None".
func parseHeardRepeats(v string) (hears []db.WardriveHear, none bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, false
	}
	if strings.EqualFold(v, "none") {
		return nil, true
	}
	seen := make(map[string]bool)
	for part := range strings.SplitSeq(v, ",") {
		part = strings.TrimSpace(part)
		id, snrStr := part, ""
		if i := strings.IndexByte(part, '('); i >= 0 && strings.HasSuffix(part, ")") {
			id, snrStr = part[:i], part[i+1:len(part)-1]
		}
		id = strings.ToUpper(strings.TrimSpace(id))
		if !validPrefix(id) || seen[id] {
			continue
		}
		seen[id] = true
		hear := db.WardriveHear{RepeaterPrefix: id}
		if f, err := strconv.ParseFloat(strings.TrimSpace(snrStr), 64); err == nil {
			hear.SNR = snrPtr(&f)
		}
		hears = append(hears, hear)
	}
	return hears, false
}

func validPrefix(id string) bool {
	if n := len(id); n != 2 && n != 4 && n != 6 && n != 8 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func validCoord(lat, lon float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return false
	}
	return math.Abs(lat) > 1e-6 || math.Abs(lon) > 1e-6 // "null island" = no GPS fix
}

func snrPtr(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || *v < -40 || *v > 40 {
		return nil
	}
	f := math.Round(*v*100) / 100
	return &f
}

func rssiPtr(v *float64) *int {
	if v == nil || *v >= 0 || *v < -200 {
		return nil // 0 means "unreadable" per the MeshMapper spec
	}
	i := int(math.Round(*v))
	return &i
}

func normalizeIATA(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 3 {
		return ""
	}
	for _, c := range s {
		if c < 'A' || c > 'Z' {
			return ""
		}
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// deviceHash pseudonymises the app's contact key prefix so the raw key is never
// stored but pings from one device can still be grouped (dedupe, speed check,
// distinct-device counts).
func (h *Handler) deviceHash(contact string) string {
	contact = strings.ToUpper(strings.TrimSpace(contact))
	if contact == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(h.opt.Salt + "|" + contact))
	return hex.EncodeToString(sum[:16])
}

// clientIP resolves the caller's IP. X-Forwarded-For is honoured only when the
// direct peer is a trusted proxy, and is walked right-to-left skipping trusted
// hops, so a client can't spoof its way past the limiter by prepending entries.
// Single-value headers such as CF-Connecting-IP are deliberately ignored: the
// server forwards from loopback (always trusted), so a client reaching the
// proxy directly could set them freely. Behind Cloudflare, add its CIDRs to
// trustedProxies instead.
func (h *Handler) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer := net.ParseIP(host)
	if peer == nil || !h.isTrusted(peer) {
		return host
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for i, part := range slices.Backward(strings.Split(xff, ",")) {
			ip := net.ParseIP(strings.TrimSpace(part))
			if ip == nil {
				break
			}
			if !h.isTrusted(ip) || i == 0 {
				return ip.String()
			}
		}
	}
	return host
}

func (h *Handler) isTrusted(ip net.IP) bool {
	for _, n := range h.trusted {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// limiter is a per-key token bucket with idle eviction.
type limiter struct {
	mu        sync.Mutex
	now       func() time.Time
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(now func() time.Time) *limiter {
	return &limiter{now: now, buckets: make(map[string]*bucket)}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) > limiterIdleTTL {
		for k, b := range l.buckets {
			if now.Sub(b.last) > limiterIdleTTL {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: rateBurst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(rateBurst, b.tokens+now.Sub(b.last).Seconds()*ratePerSecond)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
