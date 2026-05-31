package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/store"
)

// decodeHexPacket wraps the decoder package so handlers.go stays thin.
func decodeHexPacket(hex string) (interface{}, error) {
	pkt, err := decoder.DecodePacket(hex, nil)
	if err != nil {
		return nil, err
	}
	return pkt, nil
}

// Server holds all dependencies for the HTTP handlers.
type Server struct {
	Store *store.Store
	Hub   *Hub
}

func NewServer(st *store.Store, hub *Hub) *Server {
	return &Server{Store: st, Hub: hub}
}

// Router returns a configured mux.Router.
func (s *Server) Router() *mux.Router {
	r := mux.NewRouter()
	r.Use(corsMiddleware)
	r.HandleFunc("/ws", s.Hub.ServeWS)
	api := r.PathPrefix("/api").Subrouter()

	api.HandleFunc("/packets", s.listPackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/packets/{hash}", s.getPacket).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes", s.listNodes).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}", s.getNode).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/packets", s.getNodePackets).Methods("GET", "OPTIONS")
	api.HandleFunc("/nodes/{pubkey}/rf", s.getNodeRF).Methods("GET", "OPTIONS")
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
	api.HandleFunc("/observers/{id}/analytics", s.getObserverAnalytics).Methods("GET", "OPTIONS")
	api.HandleFunc("/decode", s.decodePacket).Methods("POST", "OPTIONS")

	return r
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
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
		out.Nodes = append(out.Nodes, summarizeNode(n))
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
	writeJSON(w, s.Store.Channels())
}

func (s *Server) getChannelMessages(w http.ResponseWriter, r *http.Request) {
	hash := mux.Vars(r)["hash"]
	limit := queryInt(r, "limit", 100)
	msgs := s.Store.ChannelMessages(hash, limit)
	out := make([]packetSummary, 0, len(msgs))
	for _, tx := range msgs {
		out = append(out, summarizeTx(tx))
	}
	writeJSON(w, out)
}

func (s *Server) getOverview(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.Overview())
}

func (s *Server) getPacketsByType(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.PacketsByType())
}

func (s *Server) getAnalyticsRF(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Store.GlobalRFStats())
}

func (s *Server) getAnalyticsActivity(w http.ResponseWriter, r *http.Request) {
	hours := queryInt(r, "hours", 24)
	if hours > 168 {
		hours = 168 // cap at 7 days
	}
	writeJSON(w, s.Store.ActivityBuckets(hours))
}

func (s *Server) getAnalyticsNodesTop(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 20)
	nodes := s.Store.TopNodes(limit)
	out := make([]nodeSummary, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, summarizeNode(n))
	}
	writeJSON(w, out)
}

func (s *Server) getAnalyticsObserversTop(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 20)
	obs := s.Store.TopObservers(limit)
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
		Hex string `json:"hex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	// Delegate to the decoder package via a thin import
	// We return a structured error so the frontend can display it cleanly
	type decodeResp struct {
		OK      bool        `json:"ok"`
		Error   string      `json:"error,omitempty"`
		Decoded interface{} `json:"decoded,omitempty"`
	}
	if body.Hex == "" {
		writeJSON(w, decodeResp{OK: false, Error: "hex is empty"})
		return
	}
	// Import decoder inline — call our existing decoder package
	result, err := decodeHexPacket(body.Hex)
	if err != nil {
		writeJSON(w, decodeResp{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, decodeResp{OK: true, Decoded: result})
}

// Response shape types

type packetSummary struct {
	ID          int64                  `json:"id"`
	Hash        string                 `json:"hash"`
	FirstSeen   string                 `json:"firstSeen"`
	RouteType   int                    `json:"routeType"`
	PayloadType int                    `json:"payloadType"`
	ObsCount    int                    `json:"obsCount"`
	ChannelHash string                 `json:"channelHash,omitempty"`
	Decoded     map[string]interface{} `json:"decoded,omitempty"`
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
	Timestamp    string   `json:"timestamp"`
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
	return packetSummary{
		ID: tx.ID, Hash: tx.Hash, FirstSeen: tx.FirstSeen,
		RouteType: tx.RouteType, PayloadType: tx.PayloadType,
		ObsCount: tx.ObsCount, ChannelHash: tx.ChannelHash,
		Decoded: tx.Decoded(),
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
			Direction: o.Direction, PathJSON: o.PathJSON, Timestamp: o.Timestamp,
		})
	}
	return d
}

func summarizeNode(n *store.Node) nodeSummary {
	return nodeSummary{
		PubKey: n.PubKey, Name: n.Name, Role: n.Role, Lat: n.Lat, Lon: n.Lon,
		LastSeen: n.LastSeen, FirstSeen: n.FirstSeen, AdvertCount: n.AdvertCount,
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
