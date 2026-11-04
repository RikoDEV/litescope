package api

import (
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/store"
)

// maxPageLimit caps the "limit" query param on paginated list endpoints.
const maxPageLimit = 500

// Server holds all dependencies for the HTTP handlers.
type Server struct {
	Store          *store.Store
	Hub            *Hub
	ChannelKeys    map[string]string
	AllowedOrigins []string
	// WardriveEnabled mirrors config.wardrive.enabled so the coverage layer can
	// tell "no data yet" apart from "feature off".
	WardriveEnabled bool
	// WardriveProxy, when set, forwards POST /api/wardrive to the ingestor
	// (the only DB writer). nil leaves the route unregistered.
	WardriveProxy http.Handler
	// ObsRawHex, when set, loads the per-observation raw packet hex (keyed by
	// observation id) for one transmission. The in-memory store doesn't keep it
	// (it is the bulk of observation memory); the packet-detail endpoint fetches
	// it on demand. nil omits rawHex from observation details.
	ObsRawHex func(txID int64) (map[int64]string, error)

	// Archive, when its window is set, serves reads past the in-memory window
	// from SQLite and all-time statistics from rollups. nil = all in memory.
	Archive *Archive

	resp *responseCache
}

func NewServer(st *store.Store, hub *Hub, channelKeys map[string]string, allowedOrigins []string) *Server {
	return &Server{Store: st, Hub: hub, ChannelKeys: channelKeys, AllowedOrigins: allowedOrigins, resp: newResponseCache()}
}

// Router returns a configured mux.Router.
func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.Use(corsMiddleware(s.AllowedOrigins))
	r.HandleFunc("/ws", s.Hub.ServeWS)
	api := r.PathPrefix("/api").Subrouter()
	api.Use(slowRequestMiddleware(2 * time.Second))

	api.HandleFunc("/packets", s.listPackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/packets/{hash}", s.getPacket).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes", s.listNodes).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}", s.getNode).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/packets", s.getNodePackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/rf", s.getNodeRF).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/overview", s.getNodeOverview).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/clock-health", s.getNodeClockHealth).Methods("GET", "OPTIONS")
	api.HandleFunc("/iatas", s.listIATAs).Methods("GET", "OPTIONS")
	api.HandleFunc("/observers", s.listObservers).Methods("GET", "OPTIONS")
	api.HandleFunc("/observers/{id}", s.getObserver).Methods("GET", "OPTIONS")
	api.HandleFunc("/channels", s.listChannels).Methods("GET", "OPTIONS")
	api.HandleFunc("/channels/{hash}/messages", s.getChannelMessages).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/overview", s.getOverview).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/packets-by-type", s.getPacketsByType).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/rf", s.getAnalyticsRF).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/activity", s.getAnalyticsActivity).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/nodes-top", s.getAnalyticsNodesTop).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/observers-top", s.getAnalyticsObserversTop).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/snr-by-type", s.getAnalyticsSNRByType).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/hashes", s.getAnalyticsHashes).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/scope", s.getAnalyticsScope).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/scope-regions", s.getAnalyticsScopeRegions).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/map-heat", s.getAnalyticsMapHeat).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/coverage", s.getAnalyticsCoverage).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/direct-links", s.getAnalyticsDirectLinks).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/channels", s.getChannelAnalytics).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/distance", s.getAnalyticsDistance).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/clock-health", s.getAnalyticsClockHealth).Methods("GET", "OPTIONS")
	api.HandleFunc("/observers/{id}/analytics", s.getObserverAnalytics).Methods("GET", "OPTIONS")
	api.HandleFunc("/decode", s.decodePacket).Methods("POST", "OPTIONS")
	api.HandleFunc("/features", s.getFeatures).Methods("GET", "OPTIONS")
	if s.WardriveProxy != nil {
		api.Handle("/wardrive", s.WardriveProxy).Methods("POST", "OPTIONS")
	}

	return r
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func slowRequestMiddleware(threshold time.Duration) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if dur := time.Since(start); dur >= threshold {
				log.Printf("slow request: %s %s status=%d duration=%s",
					r.Method, r.URL.RequestURI(), rec.status, dur.Round(time.Millisecond))
			}
		})
	}
}

// originAllowed reports whether an Origin header value passes the allowlist.
// An empty allowlist or one containing "*" permits any origin. Requests with no
// Origin header (same-origin or non-browser clients) are always allowed.
func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return true
	}
	for _, a := range allowed {
		if a == "*" || a == origin {
			return true
		}
	}
	return false
}

func isWildcard(allowed []string) bool {
	return slices.Contains(allowed, "*")
}

func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	wildcard := isWildcard(allowed)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			origin := r.Header.Get("Origin")
			if wildcard {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else if origin != "" && originAllowed(origin, allowed) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// queryInt parses a non-negative integer query parameter. Every caller uses it
// for counts/offsets/time windows, where a negative value is meaningless and —
// passed through to the store — could panic (negative slice cap or bound).
func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

func queryInt64(r *http.Request, key string, def int64) int64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// analyticsFilter builds a store.AnalyticsFilter from shared query params used by
// every analytics endpoint: hours (time window, 0/absent = all time), regions
// (comma-separated IATA codes) and lock (exclusive region matching).
func analyticsFilter(r *http.Request) store.AnalyticsFilter {
	return analyticsFilterWithDefaultHours(r, 0)
}

func analyticsFilterWithDefaultHours(r *http.Request, defaultHours int) store.AnalyticsFilter {
	q := r.URL.Query()
	hours := defaultHours
	if q.Get("hours") != "" {
		hours = queryInt(r, "hours", 0)
	}
	hours = min(hours, store.MaxAnalyticsWindowHours)
	regions, lock := regionFilterParam(q)
	countries := csvParam(q, "countries")
	return store.NewAnalyticsFilter(hours, regions, countries, lock)
}

// regionFilterParam reads the "regions" (comma-separated IATA codes) and
// "lock" (exclusive region matching) query params shared by every endpoint
// that filters by observer region.
func regionFilterParam(q url.Values) (regions []string, lock bool) {
	regions = csvParam(q, "regions")
	lock = q.Get("lock") == "1" || q.Get("lock") == "true"
	return regions, lock
}

func csvParam(q map[string][]string, keys ...string) []string {
	for _, key := range keys {
		if vals, ok := q[key]; ok {
			var out []string
			for _, v := range vals {
				for part := range strings.SplitSeq(v, ",") {
					if s := strings.TrimSpace(part); s != "" {
						out = append(out, s)
					}
				}
			}
			return out
		}
	}
	return nil
}

func intSetParam(q map[string][]string, keys ...string) map[int]bool {
	vals := csvParam(q, keys...)
	if len(vals) == 0 {
		return nil
	}
	out := make(map[int]bool, len(vals))
	for _, v := range vals {
		if n, err := strconv.Atoi(v); err == nil {
			out[n] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func packetQuery(r *http.Request, limit, offset int) store.PacketQuery {
	q := r.URL.Query()
	regions, lock := regionFilterParam(q)

	pq := store.PacketQuery{
		Limit:        limit,
		Offset:       offset,
		Search:       q.Get("search"),
		PayloadTypes: intSetParam(q, "types", "payloadTypes"),
		MinObs:       queryInt(r, "minObs", 1),
		SinceMs:      queryInt64(r, "sinceMs", 0),
		RegionFilter: store.NewAnalyticsFilter(0, regions, nil, lock),
		SortCol:      q.Get("sort"),
		SortDesc:     q.Get("dir") != "asc",
	}
	if v := q.Get("routeType"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			pq.RouteType = &n
		}
	} else if v := q.Get("route"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			pq.RouteType = &n
		}
	}
	return pq
}

func (s *Server) listPackets(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50)
	offset := queryInt(r, "offset", 0)
	if limit > maxPageLimit {
		limit = maxPageLimit
	}
	pq := packetQuery(r, limit, offset)
	txs, total := s.Store.PacketsFiltered(pq)
	// With a memory window, the newest-first list continues into SQLite once
	// the in-memory matches run out, and the total includes older matches.
	// (Other sort orders only cover the in-memory window.)
	if s.Archive.enabled() && (pq.SortCol == "" || pq.SortCol == "firstSeen") && pq.SortDesc {
		aq := archivePacketQuery(r, pq)
		boundary := s.Store.WindowStartTxID()
		older, err := archiveCached(s.Archive, "count|"+boundaryBucket(boundary)+"|"+archiveKey(aq), func() (int, error) {
			return s.Archive.DB.CountOlderPackets(aq, boundary)
		})
		if err != nil {
			log.Printf("archive packet count: %v", err)
		}
		if len(txs) < limit && older > 0 {
			rows, obs, err := s.Archive.DB.OlderPackets(aq, boundary, limit-len(txs), max(0, offset-total))
			if err != nil {
				log.Printf("archive packets: %v", err)
			}
			txs = append(txs, buildTxs(rows, obs)...)
		}
		total += older
	}
	type response struct {
		Total   int             `json:"total"`
		Packets []packetSummary `json:"packets"`
	}
	out := response{Total: total}
	for _, tx := range txs {
		out.Packets = append(out.Packets, summarizeTx(tx))
	}
	writeJSON(w, out)
}

func (s *Server) getPacket(w http.ResponseWriter, r *http.Request) {
	hash := mux.Vars(r)["hash"]
	tx := s.Store.PacketByHash(hash)
	if tx == nil && s.Archive.enabled() {
		// Older than the in-memory window: read it from SQLite.
		row, obs, err := s.Archive.DB.PacketByHash(hash)
		if err != nil {
			log.Printf("archive packet %s: %v", hash, err)
		}
		if row != nil {
			tx = store.BuildTx(row, obs)
		}
	}
	if tx == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var rawHex map[int64]string
	if s.ObsRawHex != nil {
		var err error
		if rawHex, err = s.ObsRawHex(tx.ID); err != nil {
			log.Printf("packet %s: load observation raw hex: %v", hash, err)
		}
	}
	writeJSON(w, txDetail(tx, rawHex))
}

func (s *Server) listNodes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	iata := q.Get("iata")
	status := q.Get("status")
	lastHeard := q.Get("lastHeard")

	var nodes []*store.Node
	if iata != "" || status != "" || lastHeard != "" {
		nodes = s.Store.NodesFiltered(iata, status, lastHeard)
	} else {
		nodes = s.Store.Nodes()
	}

	type response struct {
		Total  int            `json:"total"`
		Counts map[string]int `json:"counts"`
		Nodes  []nodeSummary  `json:"nodes"`
	}
	regionsByNode := s.Store.NodeRegionsAll()
	if s.Archive.enabled() {
		// Regions of adverts older than the memory window come from the rollup.
		regionsByNode = s.Archive.nodeRegions(regionsByNode)
	}
	observerNodes := s.Store.ObserverNodePubKeys()
	out := response{Total: len(nodes), Counts: s.Store.RoleCounts(), Nodes: make([]nodeSummary, 0, len(nodes))}
	for _, n := range nodes {
		ns := summarizeNode(n)
		ns.Regions = regionsByNode[n.PubKey]
		ns.IsObserver = observerNodes[n.PubKey]
		out.Nodes = append(out.Nodes, ns)
	}
	writeJSON(w, out)
}

func (s *Server) listIATAs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.IATAs())
}

func (s *Server) getNode(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	n := s.Store.NodeOrObserver(pk)
	if n == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ns := summarizeNode(n)
	ns.IsObserver = s.Store.IsObserverNode(n.PubKey)
	writeJSON(w, ns)
}

func (s *Server) getNodePackets(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	limit := queryInt(r, "limit", 50)
	txs := s.Store.NodePackets(pk, limit)
	out := make([]packetSummary, 0, len(txs))
	for _, tx := range txs {
		out = append(out, summarizeTx(tx))
	}
	writeJSON(w, out)
}

func (s *Server) getNodeClockHealth(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	e, ok := s.Store.NodeClockHealth(pk)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, e)
}

func (s *Server) getNodeOverview(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	n := s.Store.NodeOrObserver(pk)
	if n == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	pk = n.PubKey // canonical case (an observer-only node is requested by observer ID)

	packets := s.Store.NodePackets(pk, 0)
	today := time.Now().UTC().Truncate(24 * time.Hour)

	type obsStat struct {
		ObserverID   string   `json:"observerId"`
		ObserverName string   `json:"observerName"`
		ObserverIATA string   `json:"observerIata"`
		Count        int      `json:"count"`
		AvgSnr       *float64 `json:"avgSnr,omitempty"`
		AvgRssi      *float64 `json:"avgRssi,omitempty"`
	}
	type richPacket struct {
		packetSummary
		BestObserver string   `json:"bestObserver"`
		BestIATA     string   `json:"bestIata,omitempty"`
		BestSnr      *float64 `json:"bestSnr,omitempty"`
		BestRssi     *float64 `json:"bestRssi,omitempty"`
	}

	packetsToday := 0
	totalHops, hopCount := 0, 0
	snrSum, snrN := 0.0, 0

	type obsAccum struct {
		name, iata      string
		count           int
		snrSum, rssiSum float64
		snrN, rssiN     int
	}
	byObs := make(map[string]*obsAccum)

	recentPkts := make([]richPacket, 0, 10)

	for _, tx := range packets {
		if tx.FirstSeenMs != 0 && tx.FirstSeenMs >= today.UnixMilli() {
			packetsToday++
		}

		// RF/observer aggregates (avg SNR/hops, "heard by") describe this node's
		// own link quality, so they count only packets it ORIGINATED (its adverts).
		// Packets it merely relayed carry another sender's SNR/observers and would
		// otherwise be misattributed to this node.
		originated := false
		if dec := tx.Decoded(); dec != nil {
			if dpk, _ := dec["pubKey"].(string); dpk == pk {
				originated = true
			}
		}

		rp := richPacket{packetSummary: summarizeTx(tx)}
		for _, obs := range tx.Observations {
			// best SNR observation for this packet (shown on the row) — all packets
			if obs.HasSNR && (rp.BestSnr == nil || obs.SNR > *rp.BestSnr) {
				rp.BestObserver = obs.ObserverName
				rp.BestIATA = obs.ObserverIATA
				rp.BestSnr = obs.SNRPtr()
				rp.BestRssi = obs.RSSIPtr()
			}
			if !originated {
				continue
			}
			if len(obs.Path) > 0 {
				totalHops += len(obs.Path)
				hopCount++
			}
			if obs.HasSNR {
				snrSum += obs.SNR
				snrN++
			}
			a := byObs[obs.ObserverID]
			if a == nil {
				a = &obsAccum{name: obs.ObserverName, iata: obs.ObserverIATA}
				byObs[obs.ObserverID] = a
			}
			a.count++
			if obs.HasSNR {
				a.snrSum += obs.SNR
				a.snrN++
			}
			if obs.HasRSSI {
				a.rssiSum += obs.RSSI
				a.rssiN++
			}
		}
		if rp.BestObserver == "" && len(tx.Observations) > 0 {
			o := tx.Observations[0]
			rp.BestObserver = o.ObserverName
			rp.BestIATA = o.ObserverIATA
			rp.BestSnr = o.SNRPtr()
			rp.BestRssi = o.RSSIPtr()
		}
		if len(recentPkts) < 10 {
			recentPkts = append(recentPkts, rp)
		}
	}

	avgHops := 0.0
	if hopCount > 0 {
		avgHops = float64(totalHops) / float64(hopCount)
	}
	var avgSnr *float64
	if snrN > 0 {
		v := snrSum / float64(snrN)
		avgSnr = &v
	}

	heardBy := make([]obsStat, 0, len(byObs))
	for id, a := range byObs {
		stat := obsStat{ObserverID: id, ObserverName: a.name, ObserverIATA: a.iata, Count: a.count}
		if a.snrN > 0 {
			v := a.snrSum / float64(a.snrN)
			stat.AvgSnr = &v
		}
		if a.rssiN > 0 {
			v := a.rssiSum / float64(a.rssiN)
			stat.AvgRssi = &v
		}
		heardBy = append(heardBy, stat)
	}
	sort.Slice(heardBy, func(i, j int) bool { return heardBy[i].Count > heardBy[j].Count })

	ns := summarizeNode(n)
	ns.IsObserver = s.Store.IsObserverNode(n.PubKey)
	writeJSON(w, struct {
		nodeSummary
		PacketsToday  int          `json:"packetsToday"`
		TotalPackets  int          `json:"totalPackets"`
		AvgHops       float64      `json:"avgHops"`
		AvgSnr        *float64     `json:"avgSnr,omitempty"`
		HeardBy       []obsStat    `json:"heardBy"`
		RecentPackets []richPacket `json:"recentPackets"`
	}{
		nodeSummary:   ns,
		PacketsToday:  packetsToday,
		TotalPackets:  len(packets),
		AvgHops:       avgHops,
		AvgSnr:        avgSnr,
		HeardBy:       heardBy,
		RecentPackets: recentPkts,
	})
}

func (s *Server) getNodeRF(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	writeJSON(w, s.Store.NodeRFStats(pk))
}

func (s *Server) listObservers(w http.ResponseWriter, r *http.Request) {
	obs := s.Store.Observers()
	type response struct {
		Total     int               `json:"total"`
		Observers []observerSummary `json:"observers"`
	}
	out := response{Total: len(obs), Observers: make([]observerSummary, 0, len(obs))}
	for _, o := range obs {
		out.Observers = append(out.Observers, summarizeObserver(o))
	}
	writeJSON(w, out)
}

func (s *Server) getObserver(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	o := s.Store.ObserverByID(id)
	if o == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, summarizeObserver(o))
}

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	// Unfiltered (all-time) list from the rollup when memory holds only a
	// window — otherwise channels quiet for longer than the window would
	// vanish. Filtered (region/hours) lists come from the in-memory window.
	if f := analyticsFilter(r); s.Archive.enabled() && !f.Active() {
		if chans, err := s.Archive.channels(); err == nil {
			writeJSON(w, chans)
			return
		} else {
			log.Printf("archive channels: %v", err)
		}
	}
	s.writeCachedJSON(w, r, func() any { return s.Store.Channels(analyticsFilter(r)) })
}

func (s *Server) getChannelAnalytics(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.ChannelAnalytics(analyticsFilter(r)) })
}

func (s *Server) getChannelMessages(w http.ResponseWriter, r *http.Request) {
	hash := mux.Vars(r)["hash"]
	limit := min(queryInt(r, "limit", 100), maxPageLimit)
	offset := queryInt(r, "offset", 0)
	msgs, exhausted, memMatches := s.Store.ChannelMessagesPage(hash, limit, offset, analyticsFilter(r))
	if exhausted && s.Archive.enabled() && !s.Archive.covers(queryInt(r, "hours", 0)) {
		// Older chat history than the in-memory window: continue from SQLite.
		regions, lock := regionFilterParam(r.URL.Query())
		aq := db.ArchiveQuery{ChannelHash: hash, Regions: regions, Lock: lock, SinceISO: sinceISO(queryInt(r, "hours", 0))}
		rows, obs, err := s.Archive.DB.OlderPackets(aq, s.Store.WindowStartTxID(), limit-len(msgs), max(0, offset-memMatches))
		if err != nil {
			log.Printf("archive channel messages: %v", err)
		}
		msgs = append(msgs, buildTxs(rows, obs)...)
	}
	out := make([]packetSummary, 0, len(msgs))
	for _, tx := range msgs {
		out = append(out, summarizeTx(tx))
	}
	writeJSON(w, out)
}

func (s *Server) getOverview(w http.ResponseWriter, r *http.Request) {
	f := analyticsFilter(r)
	stats := s.Store.Overview(f)
	if s.Archive.enabled() && !f.Active() {
		// All-time packet total from the rollup (memory holds only a window).
		if n, err := s.Archive.totalPackets(); err != nil {
			log.Printf("archive total packets: %v", err)
		} else {
			stats.TotalPackets = max(stats.TotalPackets, n)
		}
	}
	writeJSON(w, stats)
}

func (s *Server) getPacketsByType(w http.ResponseWriter, r *http.Request) {
	if f := analyticsFilter(r); s.Archive.enabled() && !f.Active() {
		if byType, err := s.Archive.packetsByType(); err == nil {
			writeJSON(w, byType)
			return
		} else {
			log.Printf("archive packets by type: %v", err)
		}
	}
	s.writeCachedJSON(w, r, func() any { return s.Store.PacketsByType(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsRF(w http.ResponseWriter, r *http.Request) {
	if v := r.URL.Query().Get("summary"); (v == "1" || v == "true") && s.Archive.enabled() && !analyticsFilter(r).Active() {
		// All-time RF aggregates from the rollup (memory holds only a window).
		if rf, err := s.Archive.rfSummary(); err == nil {
			writeJSON(w, rf)
			return
		} else {
			log.Printf("archive rf summary: %v", err)
		}
	}
	s.writeCachedJSON(w, r, func() any {
		rf := s.Store.GlobalRFStats(analyticsFilter(r))
		q := r.URL.Query()
		flag := func(k string) bool { v := q.Get(k); return v == "1" || v == "true" }
		// The raw per-observation arrays grow with history (megabytes of JSON).
		// summary=1 keeps only the aggregates; histogram=1 keeps the aggregates
		// plus the pre-binned histograms and paired scatter sample the RF
		// dashboard draws. rf is a copy; the cached value keeps everything.
		switch {
		case flag("summary"):
			rf.RSSI, rf.SNR = nil, nil
			rf.SNRHistogram, rf.RSSIHistogram, rf.Scatter = nil, nil, nil
		case flag("histogram"):
			rf.RSSI, rf.SNR = nil, nil
		}
		return rf
	})
}

func (s *Server) getAnalyticsActivity(w http.ResponseWriter, r *http.Request) {
	hours := min(queryInt(r, "hours", 24), store.MaxAnalyticsWindowHours)
	s.writeCachedJSON(w, r, func() any { return s.Store.ActivityBuckets(hours, analyticsFilter(r)) })
}

func (s *Server) getAnalyticsNodesTop(w http.ResponseWriter, r *http.Request) {
	limit := min(queryInt(r, "limit", 20), maxPageLimit)
	sortBy := r.URL.Query().Get("sort") // "" | "adverts" | "retransmits"
	// Nodes are never mutated in place (updates swap in a new *Node), so the
	// encoded body is fully determined by the cached TopNodes result.
	s.writeCachedJSON(w, r, func() any {
		nodes, retx := s.Store.TopNodes(limit, sortBy, analyticsFilter(r))
		out := make([]nodeSummary, 0, len(nodes))
		for _, n := range nodes {
			ns := summarizeNode(n)
			ns.RetransmitCount = retx[n.PubKey]
			out = append(out, ns)
		}
		return out
	})
}

func (s *Server) getAnalyticsSNRByType(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.SNRByPayloadType(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsHashes(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.HashStats(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsScope(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.ScopeStats(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsScopeRegions(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.ScopeRegions(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsMapHeat(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.MapHeat(analyticsFilter(r)) })
}

// getAnalyticsCoverage serves the wardrive coverage grid. Besides the shared
// analytics filter it accepts precision=fine|coarse, repeater=<hex prefix> and
// unverified=1 (include MeshMapper DEFER "claimed" squares).
func (s *Server) getAnalyticsCoverage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.writeCachedJSON(w, r, func() any {
		res := s.Store.Coverage(analyticsFilter(r), store.CoverageOpts{
			Precision:  q.Get("precision"),
			Repeater:   q.Get("repeater"),
			Unverified: q.Get("unverified") == "1" || q.Get("unverified") == "true",
		})
		res.Enabled = s.WardriveEnabled
		return res
	})
}

// getFeatures reports which optional, config-gated features are enabled, so the
// UI can hide controls for features this instance doesn't run.
func (s *Server) getFeatures(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"coverage": s.WardriveEnabled})
}

func (s *Server) getAnalyticsDirectLinks(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.DirectLinks(analyticsFilterWithDefaultHours(r, 24)) })
}

func (s *Server) getAnalyticsDistance(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.DistanceStats(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsClockHealth(w http.ResponseWriter, r *http.Request) {
	s.writeCachedJSON(w, r, func() any { return s.Store.ClockHealth(analyticsFilter(r)) })
}

func (s *Server) getAnalyticsObserversTop(w http.ResponseWriter, r *http.Request) {
	limit := min(queryInt(r, "limit", 20), maxPageLimit)
	s.writeCachedJSON(w, r, func() any {
		obs := s.Store.TopObservers(limit, analyticsFilter(r))
		out := make([]observerSummary, 0, len(obs))
		for _, o := range obs {
			out = append(out, summarizeObserver(o))
		}
		return out
	})
}

func (s *Server) getObserverAnalytics(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	days := min(queryInt(r, "days", 7), 30)
	if s.Archive.enabled() && !s.Archive.covers(days*24) {
		// Longer than the in-memory window: from the per-observer rollup.
		if data, err := s.Archive.observerAnalytics(id, days); err == nil {
			writeJSON(w, data)
			return
		} else {
			log.Printf("archive observer analytics: %v", err)
		}
	}
	writeJSON(w, s.Store.ObserverAnalytics(id, days))
}

// archivePacketQuery maps a packet-list request onto the archive filter.
func archivePacketQuery(r *http.Request, pq store.PacketQuery) db.ArchiveQuery {
	q := r.URL.Query()
	regions, lock := regionFilterParam(q)
	aq := db.ArchiveQuery{
		Search: strings.ToLower(strings.TrimSpace(pq.Search)),
		RouteType: pq.RouteType, MinObs: pq.MinObs, Regions: regions, Lock: lock,
	}
	for pt := range pq.PayloadTypes {
		aq.PayloadTypes = append(aq.PayloadTypes, pt)
	}
	sort.Ints(aq.PayloadTypes)
	if pq.SinceMs > 0 {
		aq.SinceISO = time.UnixMilli(pq.SinceMs).UTC().Format(time.RFC3339)
	}
	return aq
}

// archiveKey is a cache key for an archive filter.
func archiveKey(aq db.ArchiveQuery) string {
	route := ""
	if aq.RouteType != nil {
		route = strconv.Itoa(*aq.RouteType)
	}
	pts := make([]string, len(aq.PayloadTypes))
	for i, pt := range aq.PayloadTypes {
		pts[i] = strconv.Itoa(pt)
	}
	regions := slices.Clone(aq.Regions)
	sort.Strings(regions)
	// SinceISO is minute-truncated so a rolling "last N minutes" filter can share entries.
	since := aq.SinceISO
	if len(since) >= 16 {
		since = since[:16]
	}
	return fmt.Sprintf("s=%s|t=%s|r=%s|m=%d|since=%s|reg=%s|lock=%t|ch=%s",
		aq.Search, strings.Join(pts, ","), route, aq.MinObs, since, strings.Join(regions, ","), aq.Lock, aq.ChannelHash)
}

// boundaryBucket groups window boundaries for count caching: the boundary
// only moves when the hourly prune drops packets out of memory.
func boundaryBucket(id int64) string { return strconv.FormatInt(id, 10) }

// sinceISO converts an "hours" request parameter to an RFC3339 lower bound
// ("" for all time).
func sinceISO(hours int) string {
	if hours <= 0 {
		return ""
	}
	return time.Now().UTC().Add(-time.Duration(hours) * time.Hour).Format(time.RFC3339)
}

func (s *Server) decodePacket(w http.ResponseWriter, r *http.Request) {
	// A MeshCore packet is at most ~256 bytes; 1 MiB leaves generous slack for
	// the JSON envelope and a large client key set while bounding memory.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var body struct {
		Hex         string            `json:"hex"`
		ChannelKeys map[string]string `json:"channelKeys,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	type decodeResp struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error,omitempty"`
		Decoded any    `json:"decoded,omitempty"`
	}
	if body.Hex == "" {
		writeJSON(w, decodeResp{OK: false, Error: "hex is empty"})
		return
	}
	// Merge server-configured keys with keys supplied by the client
	keys := make(map[string]string)
	maps.Copy(keys, s.ChannelKeys)
	maps.Copy(keys, body.ChannelKeys)
	result, err := decoder.DecodePacket(body.Hex, keys)
	if err != nil {
		writeJSON(w, decodeResp{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, decodeResp{OK: true, Decoded: result})
}

// Response shape types

type packetSummary struct {
	ID           int64          `json:"id"`
	Hash         string         `json:"hash"`
	FirstSeen    string         `json:"firstSeen"`
	RouteType    int            `json:"routeType"`
	PayloadType  int            `json:"payloadType"`
	ObsCount     int            `json:"obsCount"`
	MaxHops      int            `json:"maxHops"`
	HopSize      int            `json:"hopSize,omitempty"`
	BestScope    string         `json:"bestScope,omitempty"`
	BestPath     []string       `json:"bestPath,omitempty"`
	BestObserver string         `json:"bestObserver,omitempty"`
	Regions      []string       `json:"regions,omitempty"`
	ByteSize     int            `json:"byteSize"`
	ChannelHash  string         `json:"channelHash,omitempty"`
	Decoded      map[string]any `json:"decoded,omitempty"`
}

type packetDetail struct {
	packetSummary
	RawHex       string      `json:"rawHex"`
	Observations []obsDetail `json:"observations"`
}

type obsDetail struct {
	ID           int64    `json:"id"`
	ObserverID   string   `json:"observerId"`
	ObserverName string   `json:"observerName"`
	ObserverIATA string   `json:"observerIata"`
	RSSI         *float64 `json:"rssi"`
	SNR          *float64 `json:"snr"`
	Direction    string   `json:"direction"`
	PathJSON     string   `json:"pathJson"`
	FloodScope   string   `json:"floodScope,omitempty"`
	Timestamp    string   `json:"timestamp"`
	RawHex       string   `json:"rawHex,omitempty"`
}

type nodeSummary struct {
	PubKey          string   `json:"pubKey"`
	Name            string   `json:"name"`
	Role            string   `json:"role"`
	Lat             *float64 `json:"lat"`
	Lon             *float64 `json:"lon"`
	LocationApprox  bool     `json:"locationApprox,omitempty"`
	LastSeen        string   `json:"lastSeen"`
	FirstSeen       string   `json:"firstSeen"`
	AdvertCount     int      `json:"advertCount"`
	Regions         []string `json:"regions,omitempty"`
	Country         string   `json:"country,omitempty"`
	RetransmitCount int      `json:"retransmitCount,omitempty"`
	BatteryMv       *int     `json:"batteryMv,omitempty"`
	TempC           *float64 `json:"temperatureC,omitempty"`
	IsObserver      bool     `json:"isObserver,omitempty"`
	Scopes          []string `json:"scopes,omitempty"`
	LastScope       string   `json:"lastScope,omitempty"`
}

type observerSummary struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	IATA       string   `json:"iata"`
	LastSeen   string   `json:"lastSeen"`
	FirstSeen  string   `json:"firstSeen"`
	PktCount   int      `json:"packetCount"`
	Model      string   `json:"model,omitempty"`
	Firmware   string   `json:"firmware,omitempty"`
	BatteryMv  *int     `json:"batteryMv,omitempty"`
	UptimeSecs *int64   `json:"uptimeSecs,omitempty"`
	NoiseFloor *float64 `json:"noiseFloor,omitempty"`
}

func summarizeTx(tx *store.Tx) packetSummary {
	b := tx.BestObservation()
	obsCount := b.UniqueObs
	if obsCount == 0 {
		obsCount = tx.ObsCount // fallback for packets with no loaded observations
	}
	return packetSummary{
		ID: tx.ID, Hash: tx.Hash, FirstSeen: tx.FirstSeen,
		RouteType: tx.RouteType, PayloadType: tx.PayloadType,
		ObsCount: obsCount, MaxHops: b.MaxHops, HopSize: b.HopSize, BestScope: b.BestScope,
		BestPath: b.BestPath, BestObserver: b.BestObserver, Regions: b.Regions,
		ByteSize:    len(tx.RawHex) / 2,
		ChannelHash: tx.ChannelHash, Decoded: tx.Decoded(),
	}
}

func txDetail(tx *store.Tx, obsRawHex map[int64]string) packetDetail {
	d := packetDetail{
		packetSummary: summarizeTx(tx),
		RawHex:        tx.RawHex,
	}
	for _, o := range tx.Observations {
		d.Observations = append(d.Observations, obsDetail{
			ID: o.ID, ObserverID: o.ObserverID, ObserverName: o.ObserverName,
			ObserverIATA: o.ObserverIATA, RSSI: o.RSSIPtr(), SNR: o.SNRPtr(),
			Direction: o.Direction, PathJSON: o.PathJSON(), FloodScope: o.FloodScope, Timestamp: o.Timestamp,
			RawHex: obsRawHex[o.ID],
		})
	}
	return d
}

func summarizeNode(n *store.Node) nodeSummary {
	return nodeSummary{
		PubKey: n.PubKey, Name: n.Name, Role: n.Role, Lat: n.Lat, Lon: n.Lon,
		LocationApprox: n.LocationApprox,
		LastSeen:       n.LastSeen, FirstSeen: n.FirstSeen, AdvertCount: n.AdvertCount,
		Country:   n.Country,
		BatteryMv: n.BatteryMv, TempC: n.TempC, Scopes: n.Scopes, LastScope: n.LastScope,
	}
}

func summarizeObserver(o *store.Observer) observerSummary {
	return observerSummary{
		ID: o.ID, Name: o.Name, IATA: o.IATA, LastSeen: o.LastSeen, FirstSeen: o.FirstSeen,
		PktCount: o.PktCount, Model: o.Model, Firmware: o.Firmware,
		BatteryMv: o.BatteryMv, UptimeSecs: o.UptimeSecs, NoiseFloor: o.NoiseFloor,
	}
}
