package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/store"
)

// Server holds all dependencies for the HTTP handlers.
type Server struct {
	Store          *store.Store
	Hub            *Hub
	ChannelKeys    map[string]string
	AllowedOrigins []string
}

func NewServer(st *store.Store, hub *Hub, channelKeys map[string]string, allowedOrigins []string) *Server {
	return &Server{Store: st, Hub: hub, ChannelKeys: channelKeys, AllowedOrigins: allowedOrigins}
}

// Router returns a configured mux.Router.
func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.Use(corsMiddleware(s.AllowedOrigins))
	r.HandleFunc("/ws", s.Hub.ServeWS)
	api := r.PathPrefix("/api").Subrouter()

	api.HandleFunc("/packets", s.listPackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/packets/{hash}", s.getPacket).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes", s.listNodes).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}", s.getNode).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/packets", s.getNodePackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/rf", s.getNodeRF).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/overview", s.getNodeOverview).Methods("GET", "OPTIONS")
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
	api.HandleFunc("/analytics/channels", s.getChannelAnalytics).Methods("GET", "OPTIONS")
	api.HandleFunc("/analytics/distance", s.getAnalyticsDistance).Methods("GET", "OPTIONS")
	api.HandleFunc("/observers/{id}/analytics", s.getObserverAnalytics).Methods("GET", "OPTIONS")
	api.HandleFunc("/decode", s.decodePacket).Methods("POST", "OPTIONS")

	return r
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
	for _, a := range allowed {
		if a == "*" {
			return true
		}
	}
	return false
}

func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	wildcard := isWildcard(allowed)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// analyticsFilter builds a store.AnalyticsFilter from shared query params used by
// every analytics endpoint: hours (time window, 0/absent = all time), regions
// (comma-separated IATA codes) and lock (exclusive region matching).
func analyticsFilter(r *http.Request) store.AnalyticsFilter {
	q := r.URL.Query()
	hours := queryInt(r, "hours", 0)
	if hours > 168 {
		hours = 168 // cap at 7 days
	}
	var regions []string
	if v := q.Get("regions"); v != "" {
		regions = strings.Split(v, ",")
	}
	var countries []string
	if v := q.Get("countries"); v != "" {
		countries = strings.Split(v, ",")
	}
	lock := q.Get("lock") == "1" || q.Get("lock") == "true"
	return store.NewAnalyticsFilter(hours, regions, countries, lock)
}

func (s *Server) listPackets(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50)
	offset := queryInt(r, "offset", 0)
	if limit > 500 {
		limit = 500
	}
	txs, total := s.Store.Packets(limit, offset)
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
	if tx == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, txDetail(tx))
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
	out := response{Total: len(nodes), Counts: s.Store.RoleCounts()}
	for _, n := range nodes {
		ns := summarizeNode(n)
		ns.Regions = s.Store.NodeRegions(n.PubKey)
		out.Nodes = append(out.Nodes, ns)
	}
	writeJSON(w, out)
}

func (s *Server) listIATAs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.IATAs())
}

func (s *Server) getNode(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	n := s.Store.NodeByPubKey(pk)
	if n == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, summarizeNode(n))
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

func (s *Server) getNodeOverview(w http.ResponseWriter, r *http.Request) {
	pk := mux.Vars(r)["pubkey"]
	n := s.Store.NodeByPubKey(pk)
	if n == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

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
		name, iata         string
		count              int
		snrSum, rssiSum    float64
		snrN, rssiN        int
	}
	byObs := make(map[string]*obsAccum)

	recentPkts := make([]richPacket, 0, 10)

	for _, tx := range packets {
		if t, err := time.Parse(time.RFC3339, tx.FirstSeen); err == nil && !t.UTC().Before(today) {
			packetsToday++
		}

		rp := richPacket{packetSummary: summarizeTx(tx)}
		for _, obs := range tx.Observations {
			var hops []string
			if json.Unmarshal([]byte(obs.PathJSON), &hops) == nil && len(hops) > 0 {
				totalHops += len(hops); hopCount++
			}
			if obs.SNR != nil {
				snrSum += *obs.SNR; snrN++
			}
			a := byObs[obs.ObserverID]
			if a == nil {
				a = &obsAccum{name: obs.ObserverName, iata: obs.ObserverIATA}
				byObs[obs.ObserverID] = a
			}
			a.count++
			if obs.SNR != nil { a.snrSum += *obs.SNR; a.snrN++ }
			if obs.RSSI != nil { a.rssiSum += *obs.RSSI; a.rssiN++ }
			// pick best SNR observation for this packet
			if obs.SNR != nil && (rp.BestSnr == nil || *obs.SNR > *rp.BestSnr) {
				rp.BestObserver = obs.ObserverName
				rp.BestIATA = obs.ObserverIATA
				rp.BestSnr = obs.SNR
				rp.BestRssi = obs.RSSI
			}
		}
		if rp.BestObserver == "" && len(tx.Observations) > 0 {
			o := tx.Observations[0]
			rp.BestObserver = o.ObserverName
			rp.BestIATA = o.ObserverIATA
			rp.BestSnr = o.SNR
			rp.BestRssi = o.RSSI
		}
		if len(recentPkts) < 10 {
			recentPkts = append(recentPkts, rp)
		}
	}

	avgHops := 0.0
	if hopCount > 0 { avgHops = float64(totalHops) / float64(hopCount) }
	var avgSnr *float64
	if snrN > 0 { v := snrSum / float64(snrN); avgSnr = &v }

	heardBy := make([]obsStat, 0, len(byObs))
	for id, a := range byObs {
		stat := obsStat{ObserverID: id, ObserverName: a.name, ObserverIATA: a.iata, Count: a.count}
		if a.snrN > 0 { v := a.snrSum / float64(a.snrN); stat.AvgSnr = &v }
		if a.rssiN > 0 { v := a.rssiSum / float64(a.rssiN); stat.AvgRssi = &v }
		heardBy = append(heardBy, stat)
	}
	sort.Slice(heardBy, func(i, j int) bool { return heardBy[i].Count > heardBy[j].Count })

	writeJSON(w, struct {
		nodeSummary
		PacketsToday  int          `json:"packetsToday"`
		TotalPackets  int          `json:"totalPackets"`
		AvgHops       float64      `json:"avgHops"`
		AvgSnr        *float64     `json:"avgSnr,omitempty"`
		HeardBy       []obsStat    `json:"heardBy"`
		RecentPackets []richPacket `json:"recentPackets"`
	}{
		nodeSummary:   summarizeNode(n),
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
	writeJSON(w, s.Store.Channels(analyticsFilter(r)))
}

func (s *Server) getChannelAnalytics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.ChannelAnalytics(analyticsFilter(r)))
}

func (s *Server) getChannelMessages(w http.ResponseWriter, r *http.Request) {
	hash := mux.Vars(r)["hash"]
	limit := queryInt(r, "limit", 100)
	if limit > 500 {
		limit = 500
	}
	offset := queryInt(r, "offset", 0)
	msgs := s.Store.ChannelMessages(hash, limit, offset)
	out := make([]packetSummary, 0, len(msgs))
	for _, tx := range msgs {
		out = append(out, summarizeTx(tx))
	}
	writeJSON(w, out)
}

func (s *Server) getOverview(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.Overview(analyticsFilter(r)))
}

func (s *Server) getPacketsByType(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.PacketsByType(analyticsFilter(r)))
}

func (s *Server) getAnalyticsRF(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.GlobalRFStats(analyticsFilter(r)))
}

func (s *Server) getAnalyticsActivity(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24)
	if hours > 168 {
		hours = 168 // cap at 7 days
	}
	writeJSON(w, s.Store.ActivityBuckets(hours, analyticsFilter(r)))
}

func (s *Server) getAnalyticsNodesTop(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 20)
	sortBy := r.URL.Query().Get("sort") // "" | "adverts" | "retransmits"
	nodes, retx := s.Store.TopNodes(limit, sortBy, analyticsFilter(r))
	out := make([]nodeSummary, 0, len(nodes))
	for _, n := range nodes {
		ns := summarizeNode(n)
		ns.RetransmitCount = retx[n.PubKey]
		out = append(out, ns)
	}
	writeJSON(w, out)
}

func (s *Server) getAnalyticsSNRByType(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.SNRByPayloadType(analyticsFilter(r)))
}

func (s *Server) getAnalyticsHashes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.HashStats(analyticsFilter(r)))
}

func (s *Server) getAnalyticsScope(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.ScopeStats(analyticsFilter(r)))
}

func (s *Server) getAnalyticsDistance(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.DistanceStats(analyticsFilter(r)))
}

func (s *Server) getAnalyticsObserversTop(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 20)
	obs := s.Store.TopObservers(limit, analyticsFilter(r))
	out := make([]observerSummary, 0, len(obs))
	for _, o := range obs {
		out = append(out, summarizeObserver(o))
	}
	writeJSON(w, out)
}

func (s *Server) getObserverAnalytics(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	days := queryInt(r, "days", 7)
	if days > 30 {
		days = 30
	}
	writeJSON(w, s.Store.ObserverAnalytics(id, days))
}

func (s *Server) decodePacket(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Hex         string            `json:"hex"`
		ChannelKeys map[string]string `json:"channelKeys,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	type decodeResp struct {
		OK      bool        `json:"ok"`
		Error   string      `json:"error,omitempty"`
		Decoded interface{} `json:"decoded,omitempty"`
	}
	if body.Hex == "" {
		writeJSON(w, decodeResp{OK: false, Error: "hex is empty"})
		return
	}
	// Merge server-configured keys with keys supplied by the client
	keys := make(map[string]string)
	for k, v := range s.ChannelKeys {
		keys[k] = v
	}
	for k, v := range body.ChannelKeys {
		keys[k] = v
	}
	result, err := decoder.DecodePacket(body.Hex, keys)
	if err != nil {
		writeJSON(w, decodeResp{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, decodeResp{OK: true, Decoded: result})
}

// Response shape types

type packetSummary struct {
	ID           int64                  `json:"id"`
	Hash         string                 `json:"hash"`
	FirstSeen    string                 `json:"firstSeen"`
	RouteType    int                    `json:"routeType"`
	PayloadType  int                    `json:"payloadType"`
	ObsCount     int                    `json:"obsCount"`
	MaxHops      int                    `json:"maxHops"`
	HopSize      int                    `json:"hopSize,omitempty"`
	BestScope    string                 `json:"bestScope,omitempty"`
	BestPath     []string               `json:"bestPath,omitempty"`
	BestObserver string                 `json:"bestObserver,omitempty"`
	Regions      []string               `json:"regions,omitempty"`
	ByteSize     int                    `json:"byteSize"`
	ChannelHash  string                 `json:"channelHash,omitempty"`
	Decoded      map[string]interface{} `json:"decoded,omitempty"`
}

type packetDetail struct {
	packetSummary
	RawHex       string       `json:"rawHex"`
	Observations []obsDetail  `json:"observations"`
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
	PubKey      string   `json:"pubKey"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Lat         *float64 `json:"lat"`
	Lon         *float64 `json:"lon"`
	LastSeen    string   `json:"lastSeen"`
	FirstSeen   string   `json:"firstSeen"`
	AdvertCount int      `json:"advertCount"`
	Regions     []string `json:"regions,omitempty"`
	Country     string   `json:"country,omitempty"`
	RetransmitCount int  `json:"retransmitCount,omitempty"`
	BatteryMv   *int     `json:"batteryMv,omitempty"`
	TempC       *float64 `json:"temperatureC,omitempty"`
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
		ByteSize: len(tx.RawHex) / 2,
		ChannelHash: tx.ChannelHash, Decoded: tx.Decoded(),
	}
}

func txDetail(tx *store.Tx) packetDetail {
	d := packetDetail{
		packetSummary: summarizeTx(tx),
		RawHex:        tx.RawHex,
	}
	for _, o := range tx.Observations {
		d.Observations = append(d.Observations, obsDetail{
			ID: o.ID, ObserverID: o.ObserverID, ObserverName: o.ObserverName,
			ObserverIATA: o.ObserverIATA, RSSI: o.RSSI, SNR: o.SNR,
			Direction: o.Direction, PathJSON: o.PathJSON, FloodScope: o.FloodScope, Timestamp: o.Timestamp,
			RawHex: o.RawHex,
		})
	}
	return d
}

func summarizeNode(n *store.Node) nodeSummary {
	return nodeSummary{
		PubKey: n.PubKey, Name: n.Name, Role: n.Role, Lat: n.Lat, Lon: n.Lon,
		LastSeen: n.LastSeen, FirstSeen: n.FirstSeen, AdvertCount: n.AdvertCount,
		Country: n.Country,
		BatteryMv: n.BatteryMv, TempC: n.TempC,
	}
}

func summarizeObserver(o *store.Observer) observerSummary {
	return observerSummary{
		ID: o.ID, Name: o.Name, IATA: o.IATA, LastSeen: o.LastSeen, FirstSeen: o.FirstSeen,
		PktCount: o.PktCount, Model: o.Model, Firmware: o.Firmware,
		BatteryMv: o.BatteryMv, UptimeSecs: o.UptimeSecs, NoiseFloor: o.NoiseFloor,
	}
}
