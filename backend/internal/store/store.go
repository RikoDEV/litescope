// Package store provides an in-memory packet store with 5 indexes.
package store

import (
	"encoding/json"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/litescope/backend/internal/db"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

func parseTimeMillis(s string) int64 {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.999999999Z07:00", "2006-01-02T15:04:05Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// Tx is an in-memory transmission record.
type Tx struct {
	ID              int64
	RawHex          string
	Hash            string
	FirstSeen       string
	RouteType       int
	PayloadType     int
	DecodedJSON     string
	ObsCount        int
	ChannelHash     string
	Observations    []*Obs
	DecodedPayload  map[string]interface{}
}

func (t *Tx) Decoded() map[string]interface{} {
	if t.DecodedPayload != nil {
		return t.DecodedPayload
	}
	var m map[string]interface{}
	json.Unmarshal([]byte(t.DecodedJSON), &m) //nolint:errcheck
	t.DecodedPayload = m
	return m
}

// Obs is an in-memory observation record.
type Obs struct {
	ID           int64
	TxID         int64
	ObserverID   string
	ObserverName string
	ObserverIATA string
	RSSI         *float64
	SNR          *float64
	Score        *float64
	Direction    string
	PathJSON     string
	FloodScope   string
	Timestamp    string
}

// Node holds an in-memory node record.
type Node struct {
	PubKey      string
	Name        string
	Role        string
	Lat         *float64
	Lon         *float64
	LastSeen    string
	FirstSeen   string
	AdvertCount int
	BatteryMv   *int
	TempC       *float64
}

// Observer holds an in-memory observer record.
type Observer struct {
	ID         string
	Name       string
	IATA       string
	LastSeen   string
	FirstSeen  string
	PktCount   int
	Model      string
	Firmware   string
	BatteryMv  *int
	UptimeSecs *int64
	NoiseFloor *float64
}

// Store is the in-memory packet store with indexed lookup.
type Store struct {
	mu         sync.RWMutex
	packets    []*Tx
	byHash     map[string]*Tx
	byTxID     map[int64]*Tx
	byObsID    map[int64]*Obs
	byObserver map[string][]*Obs
	byNode     map[string][]*Tx
	nodes      map[string]*Node
	observers  map[string]*Observer
	lastTxID   int64
	lastObsID  int64
}

func New() *Store {
	return &Store{
		byHash:     make(map[string]*Tx),
		byTxID:     make(map[int64]*Tx),
		byObsID:    make(map[int64]*Obs),
		byObserver: make(map[string][]*Obs),
		byNode:     make(map[string][]*Tx),
		nodes:      make(map[string]*Node),
		observers:  make(map[string]*Observer),
	}
}

// Load populates the store from DB rows loaded at startup.
func (s *Store) Load(txs []*db.TxRow, obss []*db.ObsRow, nodes []*db.NodeRow, obs []*db.ObserverRow) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, r := range txs {
		t := txFromRow(r)
		s.packets = append(s.packets, t)
		s.byHash[t.Hash] = t
		s.byTxID[t.ID] = t
		if t.ID > s.lastTxID {
			s.lastTxID = t.ID
		}
	}
	for _, r := range obss {
		o := obsFromRow(r)
		s.byObsID[o.ID] = o
		s.byObserver[o.ObserverID] = append(s.byObserver[o.ObserverID], o)
		if tx, ok := s.byTxID[o.TxID]; ok {
			tx.Observations = append(tx.Observations, o)
			// Index by node pub_key using ADVERT packets
			if decoded := tx.Decoded(); decoded != nil {
				if pk, ok := decoded["pubKey"].(string); ok && pk != "" {
					if _, seen := s.byNodeContains(pk, tx); !seen {
						s.byNode[pk] = append(s.byNode[pk], tx)
					}
				}
			}
		}
		if o.ID > s.lastObsID {
			s.lastObsID = o.ID
		}
	}
	for _, r := range nodes {
		s.nodes[r.PubKey] = nodeFromRow(r)
	}
	for _, r := range obs {
		s.observers[r.ID] = observerFromRow(r)
	}
}

func (s *Store) byNodeContains(pk string, tx *Tx) ([]*Tx, bool) {
	list := s.byNode[pk]
	for _, t := range list {
		if t.ID == tx.ID {
			return list, true
		}
	}
	return list, false
}

// AddTxBatch adds new transmissions (from polling) to the store.
func (s *Store) AddTxBatch(txs []*db.TxRow, obss []*db.ObsRow) []*Tx {
	s.mu.Lock()
	defer s.mu.Unlock()
	var added []*Tx
	for _, r := range txs {
		if _, ok := s.byHash[r.Hash]; ok {
			continue
		}
		t := txFromRow(r)
		s.packets = append(s.packets, t)
		s.byHash[t.Hash] = t
		s.byTxID[t.ID] = t
		if t.ID > s.lastTxID {
			s.lastTxID = t.ID
		}
		added = append(added, t)
	}
	for _, r := range obss {
		if _, ok := s.byObsID[r.ID]; ok {
			continue
		}
		o := obsFromRow(r)
		s.byObsID[o.ID] = o
		s.byObserver[o.ObserverID] = append(s.byObserver[o.ObserverID], o)
		if tx, ok := s.byTxID[o.TxID]; ok {
			tx.Observations = append(tx.Observations, o)
		}
		if o.ID > s.lastObsID {
			s.lastObsID = o.ID
		}
	}
	return added
}

// UpdateNodes merges new node rows into the in-memory node map.
func (s *Store) UpdateNodes(rows []*db.NodeRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		s.nodes[r.PubKey] = nodeFromRow(r)
	}
}

// UpdateObservers merges new observer rows into the in-memory observer map.
func (s *Store) UpdateObservers(rows []*db.ObserverRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		s.observers[r.ID] = observerFromRow(r)
	}
}

// LastIDs returns the highest known tx and obs IDs for polling.
func (s *Store) LastIDs() (int64, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastTxID, s.lastObsID
}

// Packets returns a page of packets (newest first).
func (s *Store) Packets(limit, offset int) ([]*Tx, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := len(s.packets)
	// newest first: reverse index
	start := total - 1 - offset
	var out []*Tx
	for i := start; i >= 0 && len(out) < limit; i-- {
		out = append(out, s.packets[i])
	}
	return out, total
}

// PacketByHash returns a single packet by hash.
func (s *Store) PacketByHash(hash string) *Tx {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byHash[hash]
}

// Nodes returns all nodes.
func (s *Store) Nodes() []*Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		out = append(out, n)
	}
	return out
}

// IATAs returns distinct IATA region codes from all observers.
func (s *Store) IATAs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := make(map[string]bool)
	for _, o := range s.observers {
		if o.IATA != "" {
			seen[o.IATA] = true
		}
	}
	// also collect from observations
	for _, obsList := range s.byObserver {
		for _, obs := range obsList {
			if obs.ObserverIATA != "" {
				seen[obs.ObserverIATA] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	return out
}

// NodesFiltered returns nodes matching iata/status/lastHeard filters.
// iata="SJC" → only nodes heard by observers in that region.
// status="active"|"stale" → filter by last-seen age against role thresholds.
// lastHeard="1h"|"6h"|"24h"|"7d"|"30d" → only nodes heard within that window.
func (s *Store) NodesFiltered(iata, status, lastHeard string) []*Node {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Build set of pubkeys heard by the selected IATA region
	var iataPubkeys map[string]bool
	if iata != "" {
		iataPubkeys = make(map[string]bool)
		for _, obsList := range s.byObserver {
			for _, obs := range obsList {
				if obs.ObserverIATA != iata {
					continue
				}
				tx, ok := s.byTxID[obs.TxID]
				if !ok {
					continue
				}
				dec := tx.Decoded()
				if dec == nil {
					continue
				}
				if pk, ok := dec["pubKey"].(string); ok && pk != "" {
					iataPubkeys[pk] = true
				}
			}
		}
	}

	// Parse lastHeard window
	var maxAge int64
	switch lastHeard {
	case "1h":
		maxAge = 3600000
	case "6h":
		maxAge = 21600000
	case "24h":
		maxAge = 86400000
	case "7d":
		maxAge = 604800000
	case "30d":
		maxAge = 2592000000
	}

	now := nowMillis()
	out := make([]*Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		if iataPubkeys != nil && !iataPubkeys[n.PubKey] {
			continue
		}
		if maxAge > 0 && n.LastSeen != "" {
			t := parseTimeMillis(n.LastSeen)
			if now-t > maxAge {
				continue
			}
		}
		if status == "active" || status == "stale" {
			isInfra := n.Role == "repeater" || n.Role == "room"
			var threshold int64
			if isInfra {
				threshold = 72 * 3600000
			} else {
				threshold = 24 * 3600000
			}
			age := int64(0)
			if n.LastSeen != "" {
				age = now - parseTimeMillis(n.LastSeen)
			}
			isActive := age < threshold
			if status == "active" && !isActive {
				continue
			}
			if status == "stale" && isActive {
				continue
			}
		}
		out = append(out, n)
	}
	return out
}

// RoleCounts returns per-role node counts (all nodes, no filter).
func (s *Store) RoleCounts() map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := make(map[string]int)
	for _, n := range s.nodes {
		counts[n.Role]++
	}
	return counts
}

// NodeByPubKey returns a single node.
func (s *Store) NodeByPubKey(pk string) *Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nodes[pk]
}

// NodePackets returns recent packets for a node (newest first). limit=0 returns all.
func (s *Store) NodePackets(pk string, limit int) []*Tx {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := s.byNode[pk]
	if len(list) == 0 {
		return nil
	}
	out := make([]*Tx, 0, len(list))
	for i := len(list) - 1; i >= 0; i-- {
		if limit > 0 && len(out) >= limit {
			break
		}
		out = append(out, list[i])
	}
	return out
}

// Observers returns all observers.
func (s *Store) Observers() []*Observer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Observer, 0, len(s.observers))
	for _, o := range s.observers {
		out = append(out, o)
	}
	return out
}

// ObserverByID returns a single observer.
func (s *Store) ObserverByID(id string) *Observer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.observers[id]
}

// ObserverPackets returns recent observations/packets for an observer.
func (s *Store) ObserverPackets(id string, limit int) []*Obs {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := s.byObserver[id]
	start := len(list) - 1
	var out []*Obs
	for i := start; i >= 0 && len(out) < limit; i-- {
		out = append(out, list[i])
	}
	return out
}

// Channels returns all unique channel hashes seen in GRP_TXT packets.
func (s *Store) Channels() []ChannelSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := make(map[string]*ChannelSummary)
	for _, tx := range s.packets {
		if tx.PayloadType != 5 { // GRP_TXT
			continue
		}
		if tx.ChannelHash == "" {
			continue
		}
		cs, ok := counts[tx.ChannelHash]
		if !ok {
			cs = &ChannelSummary{Hash: tx.ChannelHash, Name: tx.ChannelHash}
			counts[tx.ChannelHash] = cs
		}
		cs.MessageCount++
		// Upgrade name from hash to real name as soon as any packet carries it.
		if cs.Name == cs.Hash {
			if dec := tx.Decoded(); dec != nil {
				if ch, ok2 := dec["channel"].(string); ok2 && ch != "" {
					cs.Name = ch
				}
			}
		}
	}
	out := make([]ChannelSummary, 0, len(counts))
	for _, cs := range counts {
		out = append(out, *cs)
	}
	return out
}

type ChannelSummary struct {
	Hash         string `json:"hash"`
	Name         string `json:"name"`
	MessageCount int    `json:"messageCount"`
}

// ChannelMessages returns decrypted messages for a channel hash.
func (s *Store) ChannelMessages(chHash string, limit int) []*Tx {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Tx
	for i := len(s.packets) - 1; i >= 0 && len(out) < limit; i-- {
		tx := s.packets[i]
		if tx.ChannelHash != chHash {
			continue
		}
		dec := tx.Decoded()
		if dec == nil {
			continue
		}
		if status, _ := dec["decryptionStatus"].(string); status != "decrypted" {
			continue
		}
		out = append(out, tx)
	}
	return out
}

// Overview returns aggregate stats.
func (s *Store) Overview() OverviewStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return OverviewStats{
		TotalPackets:   len(s.packets),
		TotalNodes:     len(s.nodes),
		TotalObservers: len(s.observers),
	}
}

type OverviewStats struct {
	TotalPackets   int `json:"totalPackets"`
	TotalNodes     int `json:"totalNodes"`
	TotalObservers int `json:"totalObservers"`
}

// NodeRFStats returns RSSI/SNR arrays for a node's observations.
func (s *Store) NodeRFStats(pubKey string) RFStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var rssiVals, snrVals []float64
	for _, obs := range s.byObserver {
		for _, o := range obs {
			if tx, ok := s.byTxID[o.TxID]; ok {
				dec := tx.Decoded()
				if dec == nil {
					continue
				}
				if pk, _ := dec["pubKey"].(string); pk != pubKey {
					continue
				}
				if o.RSSI != nil {
					rssiVals = append(rssiVals, *o.RSSI)
				}
				if o.SNR != nil {
					snrVals = append(snrVals, *o.SNR)
				}
			}
		}
	}
	return RFStats{RSSI: rssiVals, SNR: snrVals}
}

type RFStats struct {
	RSSI []float64 `json:"rssi"`
	SNR  []float64 `json:"snr"`
}

// ── Analytics ────────────────────────────────────────────────────────────────

// GlobalRFStats scans all observations and returns SNR/RSSI arrays plus summary stats.
func (s *Store) GlobalRFStats() GlobalRF {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var rssi, snr []float64
	for _, obsList := range s.byObserver {
		for _, o := range obsList {
			if o.RSSI != nil {
				rssi = append(rssi, *o.RSSI)
			}
			if o.SNR != nil {
				snr = append(snr, *o.SNR)
			}
		}
	}
	return GlobalRF{
		RSSI:              rssi,
		SNR:               snr,
		TotalObservations: len(rssi),
		SNRSummary:        summarizeFloats(snr),
		RSSISummary:       summarizeFloats(rssi),
	}
}

type GlobalRF struct {
	RSSI              []float64 `json:"rssi"`
	SNR               []float64 `json:"snr"`
	TotalObservations int       `json:"totalObservations"`
	SNRSummary        FloatSummary `json:"snrSummary"`
	RSSISummary       FloatSummary `json:"rssiSummary"`
}

type FloatSummary struct {
	Avg float64 `json:"avg"`
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

func summarizeFloats(vals []float64) FloatSummary {
	if len(vals) == 0 {
		return FloatSummary{}
	}
	sum, mn, mx := 0.0, vals[0], vals[0]
	for _, v := range vals {
		sum += v
		if v < mn { mn = v }
		if v > mx { mx = v }
	}
	return FloatSummary{Avg: sum / float64(len(vals)), Min: mn, Max: mx}
}

// ActivityBuckets returns hourly packet counts for the last windowHours hours.
func (s *Store) ActivityBuckets(windowHours int) []ActivityBucket {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if windowHours <= 0 {
		windowHours = 24
	}
	now := time.Now().UTC()
	start := now.Add(-time.Duration(windowHours) * time.Hour).Truncate(time.Hour)
	buckets := make(map[int64]int)
	for _, tx := range s.packets {
		t := parseTimeToTime(tx.FirstSeen)
		if t.IsZero() || t.Before(start) {
			continue
		}
		bucket := t.Truncate(time.Hour).Unix()
		buckets[bucket]++
	}
	// Fill all hours even if empty
	var out []ActivityBucket
	for i := 0; i < windowHours; i++ {
		h := start.Add(time.Duration(i) * time.Hour)
		out = append(out, ActivityBucket{
			Hour:  h.Format(time.RFC3339),
			Label: h.Format("15:04"),
			Count: buckets[h.Unix()],
		})
	}
	return out
}

type ActivityBucket struct {
	Hour  string `json:"hour"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

func parseTimeToTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.999999999Z07:00", "2006-01-02T15:04:05Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// TopNodes returns nodes sorted by advert count descending, capped at limit.
func (s *Store) TopNodes(limit int) []*Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	nodes := make([]*Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		nodes = append(nodes, n)
	}
	// simple selection sort (small dataset)
	for i := 0; i < len(nodes) && i < limit; i++ {
		best := i
		for j := i + 1; j < len(nodes); j++ {
			if nodes[j].AdvertCount > nodes[best].AdvertCount {
				best = j
			}
		}
		nodes[i], nodes[best] = nodes[best], nodes[i]
	}
	if limit < len(nodes) {
		return nodes[:limit]
	}
	return nodes
}

// TopObservers returns observers sorted by packet count descending, capped at limit.
func (s *Store) TopObservers(limit int) []*Observer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	obs := make([]*Observer, 0, len(s.observers))
	for _, o := range s.observers {
		obs = append(obs, o)
	}
	for i := 0; i < len(obs) && i < limit; i++ {
		best := i
		for j := i + 1; j < len(obs); j++ {
			if obs[j].PktCount > obs[best].PktCount {
				best = j
			}
		}
		obs[i], obs[best] = obs[best], obs[i]
	}
	if limit < len(obs) {
		return obs[:limit]
	}
	return obs
}

// ObserverAnalytics returns timeline, SNR distribution and packet type breakdown for one observer.
func (s *Store) ObserverAnalytics(id string, days int) ObserverAnalyticsData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	obsList := s.byObserver[id]
	if len(obsList) == 0 {
		return ObserverAnalyticsData{}
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	windowHours := days * 24
	start := time.Now().UTC().Add(-time.Duration(windowHours) * time.Hour).Truncate(time.Hour)

	buckets := make(map[int64]int)
	var snrVals []float64
	typeCounts := make(map[string]int)
	payloadNames := map[int]string{
		0: "REQ", 1: "RESPONSE", 2: "TXT_MSG", 3: "ACK", 4: "ADVERT",
		5: "GRP_TXT", 6: "GRP_DATA", 7: "ANON_REQ", 8: "PATH", 9: "TRACE",
		10: "MULTIPART", 11: "CONTROL", 15: "RAW_CUSTOM",
	}

	for _, o := range obsList {
		t := parseTimeToTime(o.Timestamp)
		if t.IsZero() || t.Before(cutoff) {
			continue
		}
		bucket := t.Truncate(time.Hour).Unix()
		buckets[bucket]++
		if o.SNR != nil {
			snrVals = append(snrVals, *o.SNR)
		}
		if tx, ok := s.byTxID[o.TxID]; ok {
			name := payloadNames[tx.PayloadType]
			if name == "" { name = "UNKNOWN" }
			typeCounts[name]++
		}
	}

	var timeline []ActivityBucket
	for i := 0; i < windowHours; i++ {
		h := start.Add(time.Duration(i) * time.Hour)
		timeline = append(timeline, ActivityBucket{
			Hour:  h.Format(time.RFC3339),
			Label: h.Format("01/02 15h"),
			Count: buckets[h.Unix()],
		})
	}

	return ObserverAnalyticsData{
		Timeline:    timeline,
		SNR:         snrVals,
		SNRSummary:  summarizeFloats(snrVals),
		PacketTypes: typeCounts,
	}
}

type ObserverAnalyticsData struct {
	Timeline    []ActivityBucket `json:"timeline"`
	SNR         []float64        `json:"snr"`
	SNRSummary  FloatSummary     `json:"snrSummary"`
	PacketTypes map[string]int   `json:"packetTypes"`
}

// PacketsByType returns counts per payload type.
func (s *Store) PacketsByType() map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := map[int]string{
		0: "REQ", 1: "RESPONSE", 2: "TXT_MSG", 3: "ACK", 4: "ADVERT",
		5: "GRP_TXT", 6: "GRP_DATA", 7: "ANON_REQ", 8: "PATH", 9: "TRACE",
		10: "MULTIPART", 11: "CONTROL", 15: "RAW_CUSTOM",
	}
	out := make(map[string]int)
	for _, tx := range s.packets {
		n := names[tx.PayloadType]
		if n == "" {
			n = "UNKNOWN"
		}
		out[n]++
	}
	return out
}

// helpers

func txFromRow(r *db.TxRow) *Tx {
	return &Tx{
		ID: r.ID, RawHex: r.RawHex, Hash: r.Hash, FirstSeen: r.FirstSeen,
		RouteType: r.RouteType, PayloadType: r.PayloadType, DecodedJSON: r.DecodedJSON,
		ObsCount: r.ObsCount, ChannelHash: r.ChannelHash,
	}
}

func obsFromRow(r *db.ObsRow) *Obs {
	return &Obs{
		ID: r.ID, TxID: r.TxID, ObserverID: r.ObserverID, ObserverName: r.ObserverName,
		ObserverIATA: r.ObserverIATA, RSSI: r.RSSI, SNR: r.SNR, Score: r.Score,
		Direction: r.Direction, PathJSON: r.PathJSON, FloodScope: r.FloodScope, Timestamp: r.Timestamp,
	}
}

func nodeFromRow(r *db.NodeRow) *Node {
	return &Node{
		PubKey: r.PubKey, Name: r.Name, Role: r.Role, Lat: r.Lat, Lon: r.Lon,
		LastSeen: r.LastSeen, FirstSeen: r.FirstSeen, AdvertCount: r.AdvertCount,
		BatteryMv: r.BatteryMv, TempC: r.TempC,
	}
}

func observerFromRow(r *db.ObserverRow) *Observer {
	return &Observer{
		ID: r.ID, Name: r.Name, IATA: r.IATA, LastSeen: r.LastSeen, FirstSeen: r.FirstSeen,
		PktCount: r.PktCount, Model: r.Model, Firmware: r.Firmware,
		BatteryMv: r.BatteryMv, UptimeSecs: r.UptimeSecs, NoiseFloor: r.NoiseFloor,
	}
}

// SNRByPayloadType returns average SNR and observation count per payload type name.
func (s *Store) SNRByPayloadType() map[string]SNRTypeStat {
	s.mu.RLock()
	defer s.mu.RUnlock()
	type acc struct{ sum float64; count int }
	byType := make(map[string]*acc)
	names := map[int]string{
		0: "REQ", 1: "RESPONSE", 2: "TXT_MSG", 3: "ACK", 4: "ADVERT",
		5: "GRP_TXT", 6: "GRP_DATA", 7: "ANON_REQ", 8: "PATH", 9: "TRACE",
		10: "MULTIPART", 11: "CONTROL", 15: "RAW_CUSTOM",
	}
	for _, obsList := range s.byObserver {
		for _, o := range obsList {
			if o.SNR == nil {
				continue
			}
			tx, ok := s.byTxID[o.TxID]
			if !ok {
				continue
			}
			name := names[tx.PayloadType]
			if name == "" {
				name = "UNKNOWN"
			}
			a := byType[name]
			if a == nil {
				a = &acc{}
				byType[name] = a
			}
			a.sum += *o.SNR
			a.count++
		}
	}
	out := make(map[string]SNRTypeStat, len(byType))
	for k, a := range byType {
		if a.count > 0 {
			out[k] = SNRTypeStat{Avg: a.sum / float64(a.count), Count: a.count}
		}
	}
	return out
}

type SNRTypeStat struct {
	Avg   float64 `json:"avg"`
	Count int     `json:"count"`
}

// isHexHop returns true when s is a non-empty, even-length pure-hex string —
// i.e. a compact node identifier used in mesh routing paths (e.g. "BF57", "1536").
func isHexHop(s string) bool {
	if len(s) == 0 || len(s)%2 != 0 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// HashStats derives byte-size distribution from hex hop identifiers found in
// observation paths (PathJSON).  "1-byte" means a 2-char hex hop like "AB",
// "2-byte" means "ABCD", etc.  Full node names in paths are ignored.
func (s *Store) HashStats() HashStatsData {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sizeCount := make(map[int]int)
	roleSize := make(map[string]map[int]int)

	type adopterAcc struct{ count, maxSize int }
	adopters := make(map[string]*adopterAcc) // hex hop → acc

	const days = 14
	now := time.Now().UTC()
	start := now.AddDate(0, 0, -days).Truncate(24 * time.Hour)
	type timeBins [4]int
	overTimeMap := make(map[int64]timeBins)

	for _, obsList := range s.byObserver {
		for _, o := range obsList {
			tx, ok := s.byTxID[o.TxID]
			if !ok {
				continue
			}
			var hops []string
			if json.Unmarshal([]byte(o.PathJSON), &hops) != nil || len(hops) == 0 {
				continue
			}

			t := parseTimeToTime(tx.FirstSeen)
			inWindow := !t.IsZero() && !t.Before(start)

			// Sender role for role breakdown (only meaningful for advert packets)
			senderRole := ""
			if tx.PayloadType == 4 {
				if dec := tx.Decoded(); dec != nil {
					if pk, _ := dec["pubKey"].(string); pk != "" {
						if n := s.nodes[pk]; n != nil {
							senderRole = n.Role
						}
					}
				}
			}

			for _, hop := range hops {
				if !isHexHop(hop) {
					continue
				}
				bs := len(hop) / 2
				sizeCount[bs]++

				if senderRole != "" {
					if roleSize[senderRole] == nil {
						roleSize[senderRole] = make(map[int]int)
					}
					roleSize[senderRole][bs]++
				}

				if inWindow {
					day := t.Truncate(24 * time.Hour).Unix()
					arr := overTimeMap[day]
					switch {
					case bs == 1:
						arr[0]++
					case bs == 2:
						arr[1]++
					case bs == 3:
						arr[2]++
					default:
						arr[3]++
					}
					overTimeMap[day] = arr
				}

				if bs > 1 {
					a := adopters[hop]
					if a == nil {
						a = &adopterAcc{}
						adopters[hop] = a
					}
					a.count++
					if bs > a.maxSize {
						a.maxSize = bs
					}
				}
			}
		}
	}

	sizeDist := make(map[string]int, len(sizeCount))
	for k, v := range sizeCount {
		sizeDist[strconv.Itoa(k)] = v
	}

	byRole := make(map[string]map[string]int, len(roleSize))
	for role, sizes := range roleSize {
		byRole[role] = make(map[string]int, len(sizes))
		for k, v := range sizes {
			byRole[role][strconv.Itoa(k)] = v
		}
	}

	overTime := make([]HashTimeBucket, 0, days)
	for i := 0; i < days; i++ {
		day := start.AddDate(0, 0, i)
		arr := overTimeMap[day.Unix()]
		overTime = append(overTime, HashTimeBucket{
			Label: day.Format("01/02"),
			Size1: arr[0], Size2: arr[1], Size3: arr[2], SizeN: arr[3],
		})
	}

	adopterList := make([]HashAdopter, 0, len(adopters))
	for hop, a := range adopters {
		adopterList = append(adopterList, HashAdopter{PubKey: hop, Name: hop, Count: a.count, MaxSize: a.maxSize})
	}
	sort.Slice(adopterList, func(i, j int) bool { return adopterList[i].Count > adopterList[j].Count })
	if len(adopterList) > 20 {
		adopterList = adopterList[:20]
	}

	return HashStatsData{
		SizeDistribution:  sizeDist,
		ByRole:            byRole,
		OverTime:          overTime,
		MultiByteAdopters: adopterList,
	}
}

type HashStatsData struct {
	SizeDistribution  map[string]int            `json:"sizeDistribution"`
	ByRole            map[string]map[string]int `json:"byRole"`
	OverTime          []HashTimeBucket          `json:"overTime"`
	MultiByteAdopters []HashAdopter             `json:"multiByteAdopters"`
}

type HashTimeBucket struct {
	Label string `json:"label"`
	Size1 int    `json:"size1"`
	Size2 int    `json:"size2"`
	Size3 int    `json:"size3"`
	SizeN int    `json:"sizeN"`
}

type HashAdopter struct {
	PubKey  string `json:"pubKey"`
	Name    string `json:"name"`
	Count   int    `json:"count"`
	MaxSize int    `json:"maxSize"`
}
