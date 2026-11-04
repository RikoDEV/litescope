package store

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/geo"
)

// Wardrive coverage (issue #114): MeshMapper pings collected by the ingestor's
// /api/wardrive endpoint, aggregated into a lat/lon grid for the /map layer.
//
// Samples live under their own lock and version counter so a burst of
// wardrive uploads doesn't invalidate every packet analytics cache (and vice
// versa). Lock order: coverage computation takes s.mu (via the cached repeater
// index) and cov.mu separately, never nested.

// coverageState is the wardrive slice of the Store.
type coverageState struct {
	mu         sync.RWMutex
	samples    []*WardriveSample // ascending id ≈ arrival order
	lastID     int64
	version    atomic.Uint64
	maxKm      float64
	minDevices int
}

// WardriveSample is an in-memory wardrive ping. Immutable once added, so read
// paths may use it after releasing cov.mu.
type WardriveSample struct {
	db.WardriveSample
	Country string // ISO-A2 at the ping position (geographic filter)
}

const (
	coverageDefaultMaxKm = 150.0
	// coverageMaxSpeedMS rejects GPS jumps: two pings from one device implying
	// more than ~300 km/h are treated as spoofed/glitched.
	coverageMaxSpeedMS = 300.0 / 3.6
	// coverageSameTimeMaxM tolerates tiny position deltas within one second.
	coverageSameTimeMaxM = 1000.0
	coverageFineDeg      = 0.0027 // ≈300 m (MeshMapper's DEFER square)
	coverageCoarseDeg    = 0.0108 // ≈1.2 km
	coverageTopRepeaters = 3
	// coverageReanchorAfter consecutive speed rejects re-anchor the device track.
	coverageReanchorAfter = 3
)

// SetCoverageLimits configures the plausibility filter (maxRepeaterKm) and the
// minimum number of distinct devices a cell needs before it is shown.
func (s *Store) SetCoverageLimits(maxRepeaterKm float64, minDevices int) {
	s.cov.mu.Lock()
	defer s.cov.mu.Unlock()
	s.cov.maxKm = maxRepeaterKm
	s.cov.minDevices = minDevices
	s.cov.version.Add(1)
}

// AddWardrive merges newly polled samples. Rows at or below the high-water mark
// are ignored, so a re-delivered batch is harmless. Samples and their hears are
// written in one DB transaction and read with one query, so (unlike the
// tx/obs poll) there is no partial-link gap to guard against here.
func (s *Store) AddWardrive(rows []*db.WardriveSample) int {
	if len(rows) == 0 {
		return 0
	}
	added := make([]*WardriveSample, 0, len(rows))
	for _, r := range rows {
		added = append(added, &WardriveSample{WardriveSample: *r, Country: geo.CountryAt(r.Lat, r.Lon)})
	}
	s.cov.mu.Lock()
	defer s.cov.mu.Unlock()
	n := 0
	for _, w := range added {
		if w.ID <= s.cov.lastID {
			continue
		}
		s.cov.samples = append(s.cov.samples, w)
		s.cov.lastID = w.ID
		n++
	}
	if n > 0 {
		s.cov.version.Add(1)
	}
	return n
}

// LastWardriveID is the polling high-water mark for wardrive samples.
func (s *Store) LastWardriveID() int64 {
	s.cov.mu.RLock()
	defer s.cov.mu.RUnlock()
	return s.cov.lastID
}

// PruneCoverage drops samples with a ping time before cutoffMs. Returns the count removed.
func (s *Store) PruneCoverage(cutoffMs int64) int {
	if cutoffMs <= 0 {
		return 0
	}
	cutoff := cutoffMs / 1000
	s.cov.mu.Lock()
	defer s.cov.mu.Unlock()
	kept := s.cov.samples[:0:0]
	for _, w := range s.cov.samples {
		if w.TS >= cutoff {
			kept = append(kept, w)
		}
	}
	removed := len(s.cov.samples) - len(kept)
	if removed > 0 {
		s.cov.samples = kept
		s.cov.version.Add(1)
	}
	return removed
}

// CoverageOpts are the coverage-specific query options (on top of AnalyticsFilter).
type CoverageOpts struct {
	Precision  string // "fine" (~300 m) or "coarse" (~1.2 km, default)
	Repeater   string // hex prefix: only count hears by this repeater
	Unverified bool   // include DEFER ("claimed covered") pings
}

func (o CoverageOpts) normalized() CoverageOpts {
	if o.Precision != "fine" {
		o.Precision = "coarse"
	}
	o.Repeater = strings.ToUpper(strings.TrimSpace(o.Repeater))
	if !isHexUpper(o.Repeater) || len(o.Repeater) > 64 {
		o.Repeater = ""
	}
	return o
}

func (o CoverageOpts) cacheKey() string {
	return "p=" + o.Precision + "|rep=" + o.Repeater + "|u=" + strconv.FormatBool(o.Unverified)
}

// CoverageResult is the /api/analytics/coverage payload.
type CoverageResult struct {
	Enabled   bool           `json:"enabled"`
	CellDeg   float64        `json:"cellDeg"`
	Samples   int            `json:"samples"`
	Devices   int            `json:"devices"`
	Rejected  int            `json:"rejected"`
	Cells     []CoverageCell `json:"cells"`
}

// CoverageCell is one grid square. Lat/Lon is the south-west corner.
type CoverageCell struct {
	Lat          float64            `json:"lat"`
	Lon          float64            `json:"lon"`
	SizeLat      float64            `json:"sizeLat"`
	SizeLon      float64            `json:"sizeLon"`
	Pings        int                `json:"pings"`
	Heard        int                `json:"heard"`
	Dead         int                `json:"dead"`
	Claimed      int                `json:"claimed"`
	Devices      int                `json:"devices"`
	Ratio        float64            `json:"ratio"`
	BestSNR      *float64           `json:"bestSnr,omitempty"`
	AvgSNR       *float64           `json:"avgSnr,omitempty"`
	TopRepeaters []CoverageRepeater `json:"topRepeaters"`
	LastTS       int64              `json:"lastTs"`
}

// CoverageRepeater summarizes one repeater prefix heard within a cell. A short
// prefix can match several nodes (inherent to hash-prefix routing), so all
// candidate names are listed.
type CoverageRepeater struct {
	Prefix  string   `json:"prefix"`
	Count   int      `json:"count"`
	BestSNR *float64 `json:"bestSnr,omitempty"`
	Names   []string `json:"names,omitempty"`
	PubKeys []string `json:"pubKeys,omitempty"`
}

// Coverage aggregates wardrive samples into grid cells. Memoized on the
// coverage version plus the node version (plausibility depends on the node
// registry); both counters only grow, so their sum changes whenever either does.
func (s *Store) Coverage(f AnalyticsFilter, o CoverageOpts) CoverageResult {
	o = o.normalized()
	key := "coverage|" + o.cacheKey()
	if f.Active() {
		key += "|" + f.cacheKey()
	}
	cur := s.cov.version.Load() + s.nodeVersion.Load()
	return cachedByVersion(s, key, cur, func() CoverageResult { return s.computeCoverage(f, o) })
}

type coverageRepeaterRef struct {
	pubKey string
	name   string
	lat    float64
	lon    float64
	hasLoc bool
}

// coverageRepeaterIndex maps every 1–4 byte upper-case hex prefix of each
// repeater/room pubkey to its candidates. Cached per node version.
func (s *Store) coverageRepeaterIndex() map[string][]coverageRepeaterRef {
	return cachedNodeAnalytics(s, "coverageRepeaterIndex", func() map[string][]coverageRepeaterRef {
		s.mu.RLock()
		defer s.mu.RUnlock()
		idx := make(map[string][]coverageRepeaterRef)
		for _, n := range s.nodes {
			if n.Role != "repeater" && n.Role != "room" {
				continue
			}
			pk := strings.ToUpper(n.PubKey)
			ref := coverageRepeaterRef{pubKey: n.PubKey, name: n.Name}
			if hasUsableLocation(n) {
				ref.lat, ref.lon, ref.hasLoc = *n.Lat, *n.Lon, true
			}
			for _, l := range []int{2, 4, 6, 8} {
				if len(pk) >= l {
					idx[pk[:l]] = append(idx[pk[:l]], ref)
				}
			}
		}
		return idx
	})
}

type coverageAcc struct {
	row, col  int
	pings     int
	heard     int
	dead      int
	claimed   int
	devices   map[string]struct{}
	snrSum    float64
	snrN      int
	bestSNR   *float64
	repeaters map[string]*CoverageRepeater
	lastTS    int64
}

func (s *Store) computeCoverage(f AnalyticsFilter, o CoverageOpts) CoverageResult {
	repIdx := s.coverageRepeaterIndex()

	s.cov.mu.RLock()
	samples := s.cov.samples // immutable elements; the slice header is a snapshot
	maxKm, minDevices := s.cov.maxKm, s.cov.minDevices
	s.cov.mu.RUnlock()
	if maxKm <= 0 {
		maxKm = coverageDefaultMaxKm
	}
	if minDevices <= 0 {
		minDevices = 1
	}

	cellDeg := coverageCoarseDeg
	if o.Precision == "fine" {
		cellDeg = coverageFineDeg
	}
	res := CoverageResult{CellDeg: cellDeg, Cells: []CoverageCell{}}

	rejected := coverageSpeedRejects(samples)
	res.Rejected = len(rejected)

	cells := make(map[[2]int]*coverageAcc)
	allDevices := make(map[string]struct{})
	for _, w := range samples {
		if rejected[w.ID] {
			continue
		}
		if f.sinceMs > 0 && w.TS*1000 < f.sinceMs {
			continue
		}
		if len(f.regions) > 0 && (w.IATA == "" || !f.regions[w.IATA]) {
			continue
		}
		if len(f.countries) > 0 && (w.Country == "" || !f.countries[w.Country]) {
			continue
		}

		var hears []db.WardriveHear
		switch w.Status {
		case db.WardriveHeard:
			hears = plausibleHears(w, repIdx, maxKm)
			if len(hears) == 0 {
				res.Rejected++
				continue
			}
		case db.WardriveDead:
		case db.WardriveClaimed:
			if !o.Unverified {
				continue
			}
		default:
			continue
		}

		row := int(math.Floor(w.Lat / cellDeg))
		lonDeg := coverageLonDeg(row, cellDeg)
		col := int(math.Floor(w.Lon / lonDeg))
		k := [2]int{row, col}
		a := cells[k]
		if a == nil {
			a = &coverageAcc{row: row, col: col, devices: make(map[string]struct{}), repeaters: make(map[string]*CoverageRepeater)}
			cells[k] = a
		}
		a.pings++
		a.devices[w.DeviceHash] = struct{}{}
		allDevices[w.DeviceHash] = struct{}{}
		res.Samples++
		if w.TS > a.lastTS {
			a.lastTS = w.TS
		}

		switch w.Status {
		case db.WardriveDead:
			a.dead++
			continue
		case db.WardriveClaimed:
			a.claimed++
			continue
		}

		// Heard: with a repeater filter, a ping heard only by other repeaters
		// counts as "not heard by this one".
		counted := false
		for _, h := range hears {
			if o.Repeater != "" && !prefixOverlap(h.RepeaterPrefix, o.Repeater) {
				continue
			}
			counted = true
			r := a.repeaters[h.RepeaterPrefix]
			if r == nil {
				r = &CoverageRepeater{Prefix: h.RepeaterPrefix}
				for _, ref := range repIdx[h.RepeaterPrefix] {
					r.Names = append(r.Names, ref.name)
					r.PubKeys = append(r.PubKeys, ref.pubKey)
				}
				a.repeaters[h.RepeaterPrefix] = r
			}
			r.Count++
			if h.SNR != nil {
				if r.BestSNR == nil || *h.SNR > *r.BestSNR {
					v := *h.SNR
					r.BestSNR = &v
				}
				if a.bestSNR == nil || *h.SNR > *a.bestSNR {
					v := *h.SNR
					a.bestSNR = &v
				}
				a.snrSum += *h.SNR
				a.snrN++
			}
		}
		if counted {
			a.heard++
		} else {
			a.dead++
		}
	}
	res.Devices = len(allDevices)

	for _, a := range cells {
		if len(a.devices) < minDevices {
			continue
		}
		if o.Repeater != "" && a.heard == 0 {
			continue // per-repeater view: only that repeater's footprint
		}
		lonDeg := coverageLonDeg(a.row, cellDeg)
		c := CoverageCell{
			Lat: float64(a.row) * cellDeg, Lon: float64(a.col) * lonDeg,
			SizeLat: cellDeg, SizeLon: lonDeg,
			Pings: a.pings, Heard: a.heard, Dead: a.dead, Claimed: a.claimed,
			Devices: len(a.devices), BestSNR: a.bestSNR, LastTS: a.lastTS,
			TopRepeaters: []CoverageRepeater{},
		}
		if n := a.heard + a.dead; n > 0 {
			c.Ratio = math.Round(float64(a.heard)/float64(n)*1000) / 1000
		}
		if a.snrN > 0 {
			v := math.Round(a.snrSum/float64(a.snrN)*100) / 100
			c.AvgSNR = &v
		}
		reps := make([]*CoverageRepeater, 0, len(a.repeaters))
		for _, r := range a.repeaters {
			reps = append(reps, r)
		}
		sort.Slice(reps, func(i, j int) bool {
			if reps[i].Count != reps[j].Count {
				return reps[i].Count > reps[j].Count
			}
			return reps[i].Prefix < reps[j].Prefix
		})
		for i := 0; i < len(reps) && i < coverageTopRepeaters; i++ {
			c.TopRepeaters = append(c.TopRepeaters, *reps[i])
		}
		res.Cells = append(res.Cells, c)
	}
	sort.Slice(res.Cells, func(i, j int) bool {
		if res.Cells[i].Lat != res.Cells[j].Lat {
			return res.Cells[i].Lat < res.Cells[j].Lat
		}
		return res.Cells[i].Lon < res.Cells[j].Lon
	})
	return res
}

// coverageLonDeg widens cells toward the poles so they stay roughly square on
// the ground. Each grid row has a fixed width, keyed by its centre latitude.
func coverageLonDeg(row int, cellDeg float64) float64 {
	centre := (float64(row) + 0.5) * cellDeg
	c := math.Cos(centre * math.Pi / 180)
	return cellDeg / math.Max(c, 0.05)
}

// plausibleHears keeps the hears whose prefix matches a known repeater and,
// when any candidate has a location, at least one candidate is within maxKm.
// A prefix whose candidates are all unlocated can't be disproven and is kept.
func plausibleHears(w *WardriveSample, idx map[string][]coverageRepeaterRef, maxKm float64) []db.WardriveHear {
	out := make([]db.WardriveHear, 0, len(w.Hears))
	for _, h := range w.Hears {
		refs := idx[h.RepeaterPrefix]
		if len(refs) == 0 {
			continue
		}
		located, near := false, false
		for _, r := range refs {
			if !r.hasLoc {
				continue
			}
			located = true
			if haversineKm(w.Lat, w.Lon, r.lat, r.lon) <= maxKm {
				near = true
				break
			}
		}
		if located && !near {
			continue
		}
		out = append(out, h)
	}
	return out
}

// coverageSpeedRejects returns the IDs of samples whose device would have had
// to move implausibly fast since its previous accepted ping. Samples without a
// device hash can't be linked and are never rejected here.
func coverageSpeedRejects(samples []*WardriveSample) map[int64]bool {
	byDevice := make(map[string][]*WardriveSample)
	for _, w := range samples {
		if w.DeviceHash != "" {
			byDevice[w.DeviceHash] = append(byDevice[w.DeviceHash], w)
		}
	}
	rejected := make(map[int64]bool)
	for _, list := range byDevice {
		sort.Slice(list, func(i, j int) bool {
			if list[i].TS != list[j].TS {
				return list[i].TS < list[j].TS
			}
			return list[i].ID < list[j].ID
		})
		var last *WardriveSample
		streak := 0
		for _, w := range list {
			if last != nil && streak < coverageReanchorAfter {
				distM := haversineKm(last.Lat, last.Lon, w.Lat, w.Lon) * 1000
				dt := float64(w.TS - last.TS)
				if distM > coverageSameTimeMaxM && (dt <= 0 || distM/dt > coverageMaxSpeedMS) {
					rejected[w.ID] = true
					streak++
					continue
				}
			}
			// Accepted — or several consecutive rejects in a row, meaning the
			// earlier anchor was the glitch: re-anchor on the current ping so
			// one bad fix can't reject the rest of a session.
			last, streak = w, 0
		}
	}
	return rejected
}

func prefixOverlap(a, b string) bool {
	if len(a) > len(b) {
		a, b = b, a
	}
	return strings.HasPrefix(b, a)
}

func isHexUpper(s string) bool {
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
