// Package store provides an in-memory packet store with 5 indexes.
package store

import (
	"encoding/json"
	"maps"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/geo"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

func parseTimeMillis(s string) int64 {
	t := parseTimeToTime(s)
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// Tx is an in-memory transmission record.
type Tx struct {
	ID             int64
	RawHex         string
	Hash           string
	FirstSeen      string
	RouteType      int
	PayloadType    int
	DecodedJSON    string
	ObsCount       int
	ChannelHash    string
	Observations   []*Obs
	DecodedPayload map[string]any

	// relayHops is the set of hex relay-hash prefixes (lowercase) under which this
	// packet has already been registered in Store.byRelayHop, used to dedupe the
	// relay index as observations accrue. Maintained under the store write lock.
	relayHops map[string]struct{}
}

// Decoded returns the parsed decoded payload. The map is populated once in
// txFromRow (under the store write lock) so this is a pure read — safe to call
// from handlers holding only the read lock.
func (t *Tx) Decoded() map[string]any {
	return t.DecodedPayload
}

// BestObs summarizes routing info derived across a Tx's observations.
type BestObs struct {
	MaxHops      int
	HopSize      int
	BestScope    string
	BestPath     []string
	BestObserver string
	UniqueObs    int
	Regions      []string // distinct IATA region codes of observers that heard this packet
}

// BestObservation walks a Tx's observations once and returns the longest decoded
// hop path (and its byte size), the first non-empty flood scope, the observer
// reporting the longest path (falling back to the first observer), and the count
// of unique observers. Shared by the REST summary and the WebSocket broadcast so
// the two cannot drift.
func (t *Tx) BestObservation() BestObs {
	b := BestObs{}
	uniq := make(map[string]struct{}, len(t.Observations))
	regions := make(map[string]struct{}, len(t.Observations))
	for _, o := range t.Observations {
		uniq[o.ObserverID] = struct{}{}
		if o.ObserverIATA != "" {
			regions[o.ObserverIATA] = struct{}{}
		}
		if b.BestObserver == "" {
			b.BestObserver = o.ObserverID
		}
		if len(o.Path) > b.MaxHops {
			b.MaxHops = len(o.Path)
			b.BestPath = o.Path
			b.BestObserver = o.ObserverID
			b.HopSize = len(o.Path[0]) / 2 // hex chars → bytes
		}
		if b.BestScope == "" && o.FloodScope != "" {
			b.BestScope = o.FloodScope
		}
	}
	b.UniqueObs = len(uniq)
	if len(regions) > 0 {
		b.Regions = make([]string, 0, len(regions))
		for r := range regions {
			b.Regions = append(b.Regions, r)
		}
		sort.Strings(b.Regions)
	}
	return b
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
	Path         []string // PathJSON decoded once in obsFromRow (nil on malformed/empty)
	FloodScope   string
	Timestamp    string
	RawHex       string
}

// Node holds an in-memory node record.
type Node struct {
	PubKey      string
	Name        string
	Role        string
	Lat         *float64
	Lon         *float64
	Country     string // ISO 3166-1 alpha-2, resolved from Lat/Lon (geo filtering)
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
	// byRelayHop maps a lowercase hex relay-hash prefix to the packets that were
	// observed carrying it in a path. relayHopLengths is the set of distinct hop
	// prefix lengths (in hex chars) seen, so NodePackets can probe a node's pubkey
	// at every used length instead of scanning every packet.
	byRelayHop      map[string][]*Tx
	relayHopLengths map[int]struct{}
	nodes           map[string]*Node
	observers       map[string]*Observer
	lastTxID        int64
	lastObsID       int64

	// version bumps on every mutation; the analytics cache keys off it so a
	// result is reused only while the underlying data is unchanged.
	version atomic.Uint64
	cacheMu sync.Mutex
	cache   map[string]cacheEntry
}

type cacheEntry struct {
	version uint64
	at      time.Time
	value   any
}

// analyticsCacheTTL bounds how long a memoized analytics result is reused even
// when the store version keeps changing. On a live network a packet arrives
// roughly every second, bumping the version, so pure version-keyed caching never
// hits; serving a result up to TTL old keeps the heavy full-history scans
// (distance/geo O(N²), hashes, scope, …) from recomputing on every request.
// Overridden to 0 in tests that assert immediate invalidation.
var analyticsCacheTTL = 10 * time.Second

func New() *Store {
	return &Store{
		byHash:          make(map[string]*Tx),
		byTxID:          make(map[int64]*Tx),
		byObsID:         make(map[int64]*Obs),
		byObserver:      make(map[string][]*Obs),
		byNode:          make(map[string][]*Tx),
		byRelayHop:      make(map[string][]*Tx),
		relayHopLengths: make(map[int]struct{}),
		nodes:           make(map[string]*Node),
		observers:       make(map[string]*Observer),
		cache:           make(map[string]cacheEntry),
	}
}

// bumpVersion invalidates the analytics cache. Caller must hold the write lock.
func (s *Store) bumpVersion() { s.version.Add(1) }

// cachedAnalytics memoizes a no-arg analytics computation by store version.
// compute() is run outside the cache lock (it takes the store read lock itself),
// so concurrent callers never serialize on the cache and at worst recompute once.
func cachedAnalytics[T any](s *Store, key string, compute func() T) T {
	cur := s.version.Load()
	s.cacheMu.Lock()
	e, ok := s.cache[key]
	s.cacheMu.Unlock()
	// Reuse when the underlying data is unchanged (version match) or when the
	// cached value is still within the staleness budget.
	if ok && (e.version == cur || time.Since(e.at) < analyticsCacheTTL) {
		return e.value.(T)
	}
	val := compute()
	s.cacheMu.Lock()
	s.cache[key] = cacheEntry{version: cur, at: time.Now(), value: val}
	s.cacheMu.Unlock()
	return val
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
			s.indexByNode(tx)
			s.indexRelayHops(tx, o)
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

// AddTxBatch adds new transmissions (from polling) to the store. It returns the
// newly-added packets plus any *existing* packets that gained observations in
// this batch (so the UI can update their obs/hop counts live as a packet
// propagates and more observers report it).
func (s *Store) AddTxBatch(txs []*db.TxRow, obss []*db.ObsRow) (added []*Tx, updated []*Tx) {
	s.mu.Lock()
	defer s.mu.Unlock()
	addedIDs := make(map[int64]bool)
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
		addedIDs[t.ID] = true
	}
	updatedSet := make(map[int64]*Tx)
	for _, r := range obss {
		if _, ok := s.byObsID[r.ID]; ok {
			continue
		}
		tx, ok := s.byTxID[r.TxID]
		if !ok {
			// The observation's transmission isn't in the store yet: its INSERT
			// raced between LoadSince's two queries (the tx will be loaded by a
			// later poll). Stop without advancing lastObsID so the next poll
			// re-reads from this id and links it. obss are strictly id-ordered,
			// so deferring the remainder costs at most one extra poll of latency
			// and never orphans an observation.
			break
		}
		o := obsFromRow(r)
		s.byObsID[o.ID] = o
		s.byObserver[o.ObserverID] = append(s.byObserver[o.ObserverID], o)
		tx.Observations = append(tx.Observations, o)
		s.indexByNode(tx)
		s.indexRelayHops(tx, o)
		// Existing packet (not first seen in this batch) gained an observation.
		if !addedIDs[tx.ID] {
			updatedSet[tx.ID] = tx
		}
		if o.ID > s.lastObsID {
			s.lastObsID = o.ID
		}
	}
	for _, tx := range updatedSet {
		updated = append(updated, tx)
	}
	if len(added) > 0 || len(obss) > 0 {
		s.bumpVersion()
	}
	return added, updated
}

// Prune removes packets first seen before cutoffMs (epoch millis) from the
// in-memory store and every index. s.packets is append-order (≈ first-seen), so
// this drops an old prefix; stragglers positioned after the cutoff are left
// intact (conservative — never over-prunes). Returns the count removed. A
// cutoffMs <= 0 is a no-op. Takes the write lock.
func (s *Store) Prune(cutoffMs int64) int {
	if cutoffMs <= 0 {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	cut := 0
	for cut < len(s.packets) {
		t := parseTimeMillis(s.packets[cut].FirstSeen)
		if t == 0 || t >= cutoffMs {
			break // unparseable or recent enough — stop pruning the prefix
		}
		cut++
	}
	if cut == 0 {
		return 0
	}

	pruned := s.packets[:cut]
	prunedID := make(map[int64]bool, len(pruned))
	touchedObservers := make(map[string]bool)
	touchedNodes := make(map[string]bool)
	touchedHops := make(map[string]bool)

	for _, tx := range pruned {
		prunedID[tx.ID] = true
		delete(s.byHash, tx.Hash)
		delete(s.byTxID, tx.ID)
		for _, o := range tx.Observations {
			delete(s.byObsID, o.ID)
			touchedObservers[o.ObserverID] = true
		}
		for h := range tx.relayHops {
			touchedHops[h] = true
		}
		if dec := tx.Decoded(); dec != nil {
			if pk, _ := dec["pubKey"].(string); pk != "" {
				touchedNodes[pk] = true
			}
		}
	}

	// Filter pruned entries out of only the index buckets actually touched.
	for id := range touchedObservers {
		if kept := filterObs(s.byObserver[id], prunedID); len(kept) == 0 {
			delete(s.byObserver, id)
		} else {
			s.byObserver[id] = kept
		}
	}
	for pk := range touchedNodes {
		if kept := filterTx(s.byNode[pk], prunedID); len(kept) == 0 {
			delete(s.byNode, pk)
		} else {
			s.byNode[pk] = kept
		}
	}
	for h := range touchedHops {
		if kept := filterTx(s.byRelayHop[h], prunedID); len(kept) == 0 {
			delete(s.byRelayHop, h)
		} else {
			s.byRelayHop[h] = kept
		}
	}

	// Copy the retained tail to a fresh slice so the pruned prefix is released.
	s.packets = append([]*Tx(nil), s.packets[cut:]...)

	s.bumpVersion()
	return cut
}

func filterObs(list []*Obs, prunedTx map[int64]bool) []*Obs {
	kept := list[:0]
	for _, o := range list {
		if !prunedTx[o.TxID] {
			kept = append(kept, o)
		}
	}
	return kept
}

func filterTx(list []*Tx, prunedTx map[int64]bool) []*Tx {
	kept := list[:0]
	for _, tx := range list {
		if !prunedTx[tx.ID] {
			kept = append(kept, tx)
		}
	}
	return kept
}

// indexByNode adds tx to the per-node packet index when it carries a pubKey
// (i.e. an ADVERT). Deduplicated per tx. Caller must hold the write lock.
func (s *Store) indexByNode(tx *Tx) {
	decoded := tx.Decoded()
	if decoded == nil {
		return
	}
	pk, ok := decoded["pubKey"].(string)
	if !ok || pk == "" {
		return
	}
	if _, seen := s.byNodeContains(pk, tx); !seen {
		s.byNode[pk] = append(s.byNode[pk], tx)
	}
}

// indexRelayHops registers tx under every distinct hex relay-hash prefix present
// in observation o's path, so NodePackets can find packets relayed through a node
// by hash-prefix lookup instead of scanning the whole store. Deduplicated per
// (tx, hop) via tx.relayHops. Caller must hold the write lock.
func (s *Store) indexRelayHops(tx *Tx, o *Obs) {
	for _, h := range o.Path {
		if !isHexHop(h) {
			continue
		}
		lh := strings.ToLower(h)
		if _, dup := tx.relayHops[lh]; dup {
			continue
		}
		if tx.relayHops == nil {
			tx.relayHops = make(map[string]struct{})
		}
		tx.relayHops[lh] = struct{}{}
		s.byRelayHop[lh] = append(s.byRelayHop[lh], tx)
		s.relayHopLengths[len(lh)] = struct{}{}
	}
}

// UpdateNodes merges new node rows into the in-memory node map.
func (s *Store) UpdateNodes(rows []*db.NodeRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		s.nodes[r.PubKey] = nodeFromRow(r)
	}
	if len(rows) > 0 {
		s.bumpVersion()
	}
}

// UpdateObservers merges new observer rows into the in-memory observer map.
func (s *Store) UpdateObservers(rows []*db.ObserverRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		s.observers[r.ID] = observerFromRow(r)
	}
	if len(rows) > 0 {
		s.bumpVersion()
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
	out := make([]*Tx, 0, limit)
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

// NodeRegions returns the distinct IATA region codes of observers that have
// heard this node's advert packets — i.e. the regions the node "belongs" to for
// region/country filtering. Sorted ascending.
func (s *Store) NodeRegions(pk string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := make(map[string]struct{})
	for _, tx := range s.byNode[pk] {
		for _, o := range tx.Observations {
			if o.ObserverIATA != "" {
				seen[o.ObserverIATA] = struct{}{}
			}
		}
	}
	if len(seen) == 0 {
		return nil
	}
	out := make([]string, 0, len(seen))
	for r := range seen {
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

// NodeRegionsAll returns, for every node that has advert packets, the sorted
// distinct observer IATA regions that heard it. Computed in a single locked pass
// — the per-node NodeRegions acquired the read lock and re-walked observations
// once per node, which is O(nodes) lock churn on the /api/nodes hot path.
func (s *Store) NodeRegionsAll() map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string][]string, len(s.byNode))
	for pk, txs := range s.byNode {
		seen := make(map[string]struct{})
		for _, tx := range txs {
			for _, o := range tx.Observations {
				if o.ObserverIATA != "" {
					seen[o.ObserverIATA] = struct{}{}
				}
			}
		}
		if len(seen) == 0 {
			continue
		}
		regions := make([]string, 0, len(seen))
		for r := range seen {
			regions = append(regions, r)
		}
		sort.Strings(regions)
		out[pk] = regions
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

	// Build set of pubkeys heard by the selected IATA region. Walk the per-node
	// advert index (small) rather than every observation in the store.
	var iataPubkeys map[string]bool
	if iata != "" {
		iataPubkeys = make(map[string]bool)
		for pk, txs := range s.byNode {
		nodeLoop:
			for _, tx := range txs {
				for _, o := range tx.Observations {
					if o.ObserverIATA == iata {
						iataPubkeys[pk] = true
						break nodeLoop
					}
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

// NodePackets returns recent packets the node was involved in — its own adverts
// (which carry its pubkey) plus packets it relayed (its hash appears in the
// path) — newest first. Without the relayed packets a node's payload-type
// breakdown would only ever show ADVERT. limit=0 returns all.
func (s *Store) NodePackets(pk string, limit int) []*Tx {
	s.mu.RLock()
	defer s.mu.RUnlock()
	lpk := strings.ToLower(pk)
	seen := make(map[int64]bool)
	out := make([]*Tx, 0, len(s.byNode[pk]))
	for _, tx := range s.byNode[pk] { // adverts (originated by this node)
		if !seen[tx.ID] {
			seen[tx.ID] = true
			out = append(out, tx)
		}
	}
	// Relayed through this node: probe the relay index at every hop-prefix length
	// the network uses, matching the node's pubkey against the hops carried in
	// observation paths — O(matching packets) instead of a full-store scan.
	for l := range s.relayHopLengths {
		if len(lpk) < l {
			continue
		}
		for _, tx := range s.byRelayHop[lpk[:l]] {
			if !seen[tx.ID] {
				seen[tx.ID] = true
				out = append(out, tx)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID }) // newest first
	if limit > 0 && len(out) > limit {
		out = out[:limit]
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

// Channels returns all unique channel hashes seen in GRP_TXT packets. The
// channel hash is a single byte, so many distinct channels collide on it; a raw
// per-hash packet count is therefore inflated for any channel we can actually
// read. When at least one packet for a hash decrypted, MessageCount reports the
// decrypted ("readable") count instead — the real number of messages for that
// channel. Hashes we never decrypted (no key on the server) fall back to the raw
// count, since we can't tell the colliding channels apart.
func (s *Store) Channels(f AnalyticsFilter) []ChannelSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	type acc struct {
		total, decrypted int
		name             string
	}
	accs := make(map[string]*acc)
	for _, tx := range s.packets {
		if tx.PayloadType != 5 { // GRP_TXT
			continue
		}
		if tx.ChannelHash == "" {
			continue
		}
		if !f.txOK(tx) {
			continue
		}
		a, ok := accs[tx.ChannelHash]
		if !ok {
			a = &acc{name: tx.ChannelHash}
			accs[tx.ChannelHash] = a
		}
		a.total++
		if dec := tx.Decoded(); dec != nil {
			if status, _ := dec["decryptionStatus"].(string); status == "decrypted" {
				a.decrypted++
			}
			// Upgrade name from hash to real name as soon as any packet carries it.
			if a.name == tx.ChannelHash {
				if ch, ok2 := dec["channel"].(string); ok2 && ch != "" {
					a.name = ch
				}
			}
		}
	}
	out := make([]ChannelSummary, 0, len(accs))
	for hash, a := range accs {
		count := a.total
		if a.decrypted > 0 {
			count = a.decrypted
		}
		out = append(out, ChannelSummary{Hash: hash, Name: a.name, MessageCount: count})
	}
	return out
}

type ChannelSummary struct {
	Hash         string `json:"hash"`
	Name         string `json:"name"`
	MessageCount int    `json:"messageCount"`
}

// ChannelMessages returns all messages for a channel hash. Both backend-decrypted
// messages and still-encrypted ones (no_key / decryption_failed) are returned, so
// the client can decrypt channels whose keys live only in the browser (Key
// Manager). The client decides what to display.
func (s *Store) ChannelMessages(chHash string, limit, offset int) []*Tx {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Tx
	skipped := 0
	for i := len(s.packets) - 1; i >= 0 && len(out) < limit; i-- {
		tx := s.packets[i]
		if tx.ChannelHash != chHash {
			continue
		}
		dec := tx.Decoded()
		if dec == nil {
			continue
		}
		if skipped < offset {
			skipped++
			continue
		}
		out = append(out, tx)
	}
	return out
}

// ChannelAnalytics returns per-channel hourly message activity (last 24 h) and
// an all-time leaderboard of top senders, derived from GRP_TXT packets.
func (s *Store) ChannelAnalytics(f AnalyticsFilter) ChannelAnalyticsData {
	if f.Active() {
		return s.computeChannelAnalytics(f)
	}
	return cachedAnalytics(s, "channelAnalytics", func() ChannelAnalyticsData { return s.computeChannelAnalytics(AnalyticsFilter{}) })
}

func (s *Store) computeChannelAnalytics(f AnalyticsFilter) ChannelAnalyticsData {
	s.mu.RLock()
	defer s.mu.RUnlock()

	const windowHours = 24
	const topChannels = 6
	now := time.Now().UTC()
	actStart := now.Add(-windowHours * time.Hour).Truncate(time.Hour)

	nameByHash := make(map[string]string)
	activityByHash := make(map[int64]map[string]int) // hourUnix → channelHash → count
	totalByHash := make(map[string]int)              // in-window totals for ranking

	type senderAcc struct {
		count    int
		channels map[string]bool
	}
	senders := make(map[string]*senderAcc)

	for _, tx := range s.packets {
		if tx.PayloadType != 5 || tx.ChannelHash == "" { // GRP_TXT
			continue
		}
		if !f.txOK(tx) {
			continue
		}
		dec := tx.Decoded()
		if dec != nil {
			if ch, _ := dec["channel"].(string); ch != "" {
				nameByHash[tx.ChannelHash] = ch
			}
		}

		t := parseTimeToTime(tx.FirstSeen)
		if !t.IsZero() && !t.Before(actStart) {
			b := t.Truncate(time.Hour).Unix()
			if activityByHash[b] == nil {
				activityByHash[b] = make(map[string]int)
			}
			activityByHash[b][tx.ChannelHash]++
			totalByHash[tx.ChannelHash]++
		}

		if dec != nil {
			if status, _ := dec["decryptionStatus"].(string); status == "decrypted" {
				if sender, _ := dec["sender"].(string); sender != "" {
					a := senders[sender]
					if a == nil {
						a = &senderAcc{channels: make(map[string]bool)}
						senders[sender] = a
					}
					a.count++
					a.channels[tx.ChannelHash] = true
				}
			}
		}
	}

	chanName := func(hash string) string {
		if n := nameByHash[hash]; n != "" {
			return n
		}
		return hash
	}

	// Rank channels by in-window volume; keep the top N, fold the rest into "Other".
	ranked := make([]string, 0, len(totalByHash))
	for h := range totalByHash {
		ranked = append(ranked, h)
	}
	sort.Slice(ranked, func(i, j int) bool { return totalByHash[ranked[i]] > totalByHash[ranked[j]] })
	keep := make(map[string]bool)
	legend := make([]string, 0, topChannels+1)
	hasOther := false
	for i, h := range ranked {
		if i < topChannels {
			keep[h] = true
			legend = append(legend, chanName(h))
		} else {
			hasOther = true
		}
	}
	const otherLabel = "Other"
	if hasOther {
		legend = append(legend, otherLabel)
	}

	hours := make([]ChannelHour, windowHours)
	for i := range windowHours {
		h := actStart.Add(time.Duration(i) * time.Hour)
		counts := make(map[string]int)
		for hash, c := range activityByHash[h.Unix()] {
			label := otherLabel
			if keep[hash] {
				label = chanName(hash)
			}
			counts[label] += c
		}
		hours[i] = ChannelHour{Hour: h.Format(time.RFC3339), Label: h.Format("15:04"), Counts: counts}
	}

	topSenders := make([]ChannelSender, 0, len(senders))
	for name, a := range senders {
		topSenders = append(topSenders, ChannelSender{Sender: name, MessageCount: a.count, Channels: len(a.channels)})
	}
	sort.Slice(topSenders, func(i, j int) bool {
		if topSenders[i].MessageCount != topSenders[j].MessageCount {
			return topSenders[i].MessageCount > topSenders[j].MessageCount
		}
		return topSenders[i].Sender < topSenders[j].Sender
	})
	if len(topSenders) > 20 {
		topSenders = topSenders[:20]
	}

	return ChannelAnalyticsData{
		ActivityChannels: legend,
		Activity:         hours,
		TopSenders:       topSenders,
	}
}

type ChannelAnalyticsData struct {
	ActivityChannels []string        `json:"activityChannels"`
	Activity         []ChannelHour   `json:"activity"`
	TopSenders       []ChannelSender `json:"topSenders"`
}

type ChannelHour struct {
	Hour   string         `json:"hour"`
	Label  string         `json:"label"`
	Counts map[string]int `json:"counts"`
}

type ChannelSender struct {
	Sender       string `json:"sender"`
	MessageCount int    `json:"messageCount"`
	Channels     int    `json:"channels"`
}

// ── Analytics filtering ────────────────────────────────────────────────────────

// AnalyticsFilter scopes analytics to a time window and/or a set of observer
// regions (IATA codes). The zero value matches everything.
type AnalyticsFilter struct {
	sinceMs   int64           // 0 = all time
	regions   map[string]bool // observer IATA set; nil/empty = all (packet/observation filtering)
	countries map[string]bool // ISO-A2 set for geographic node filtering; nil/empty = all
	lock      bool            // true → packet must be heard EXCLUSIVELY within regions
}

// NewAnalyticsFilter builds a filter from request params. hours<=0 means all time.
// regions are observer IATA codes (packet/observation filtering); countries are
// ISO-A2 codes for geographic node filtering ("strict" by node position).
func NewAnalyticsFilter(hours int, regions, countries []string, lock bool) AnalyticsFilter {
	f := AnalyticsFilter{lock: lock}
	if hours > 0 {
		f.sinceMs = nowMillis() - int64(hours)*3_600_000
	}
	if len(regions) > 0 {
		f.regions = make(map[string]bool, len(regions))
		for _, r := range regions {
			if r != "" {
				f.regions[r] = true
			}
		}
	}
	if len(countries) > 0 {
		f.countries = make(map[string]bool, len(countries))
		for _, c := range countries {
			if c != "" {
				f.countries[c] = true
			}
		}
	}
	return f
}

// Active reports whether the filter restricts anything, so callers can keep the
// cached fast path when it doesn't.
func (f AnalyticsFilter) Active() bool {
	return f.sinceMs > 0 || len(f.regions) > 0 || len(f.countries) > 0
}

// nodeGeoOK reports whether a node passes the geographic country filter. Strict:
// when countries are set, a node with no resolvable country is excluded.
func (f AnalyticsFilter) nodeGeoOK(n *Node) bool {
	if len(f.countries) == 0 {
		return true
	}
	return n.Country != "" && f.countries[n.Country]
}

func (f AnalyticsFilter) timeOK(tx *Tx) bool {
	return f.sinceMs == 0 || parseTimeMillis(tx.FirstSeen) >= f.sinceMs
}

// regionOK reports whether a packet matches the region filter, considering only
// observers with a known IATA (mirrors the frontend packet.regions semantics).
func (f AnalyticsFilter) regionOK(tx *Tx) bool {
	if len(f.regions) == 0 {
		return true
	}
	any, all, has := false, true, false
	for _, o := range tx.Observations {
		if o.ObserverIATA == "" {
			continue
		}
		has = true
		if f.regions[o.ObserverIATA] {
			any = true
		} else {
			all = false
		}
	}
	if f.lock {
		return has && all
	}
	return any
}

// txOK combines the time and region predicates for packet-level analytics.
func (f AnalyticsFilter) txOK(tx *Tx) bool { return f.timeOK(tx) && f.regionOK(tx) }

// obsOK reports whether an individual observation should be counted for
// observation-level analytics (restricted to region observers when a region is set).
func (f AnalyticsFilter) obsOK(o *Obs) bool {
	if len(f.regions) == 0 {
		return true
	}
	return o.ObserverIATA != "" && f.regions[o.ObserverIATA]
}

// Overview returns aggregate stats.
func (s *Store) Overview(f AnalyticsFilter) OverviewStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !f.Active() {
		return OverviewStats{
			TotalPackets:   len(s.packets),
			TotalNodes:     len(s.nodes),
			TotalObservers: len(s.observers),
			PacketRate:     s.packetRate(),
		}
	}
	pkts, rate := 0, 0
	rateCut := nowMillis() - 60_000
	nodes := make(map[string]bool)
	observers := make(map[string]bool)
	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		pkts++
		if parseTimeMillis(tx.FirstSeen) >= rateCut {
			rate++
		}
		if dec := tx.Decoded(); dec != nil {
			if pk, _ := dec["pubKey"].(string); pk != "" {
				if len(f.countries) == 0 {
					nodes[pk] = true
				} else if n := s.nodes[pk]; n != nil && f.nodeGeoOK(n) {
					nodes[pk] = true
				}
			}
		}
		for _, o := range tx.Observations {
			if f.obsOK(o) {
				observers[o.ObserverID] = true
			}
		}
	}
	return OverviewStats{TotalPackets: pkts, TotalNodes: len(nodes), TotalObservers: len(observers), PacketRate: rate}
}

// packetRate counts packets seen within the last minute. Caller must hold the
// read lock. s.packets is in arrival order (oldest first), so we scan from the
// newest end and stop once we cross the 1-minute boundary.
func (s *Store) packetRate() int {
	cut := time.Now().UTC().Add(-time.Minute)
	rate := 0
	for _, v := range slices.Backward(s.packets) {
		t := parseTimeToTime(v.FirstSeen)
		if t.IsZero() {
			continue
		}
		if t.Before(cut) {
			break
		}
		rate++
	}
	return rate
}

type OverviewStats struct {
	TotalPackets   int `json:"totalPackets"`
	TotalNodes     int `json:"totalNodes"`
	TotalObservers int `json:"totalObservers"`
	PacketRate     int `json:"packetRate"`
}

// NodeRFStats returns RSSI/SNR arrays for a node's observations. Uses the byNode
// index (tx's whose decoded pubKey matches) instead of scanning every observation.
func (s *Store) NodeRFStats(pubKey string) RFStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var rssiVals, snrVals []float64
	for _, tx := range s.byNode[pubKey] {
		for _, o := range tx.Observations {
			if o.RSSI != nil {
				rssiVals = append(rssiVals, *o.RSSI)
			}
			if o.SNR != nil {
				snrVals = append(snrVals, *o.SNR)
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
func (s *Store) GlobalRFStats(f AnalyticsFilter) GlobalRF {
	if f.Active() {
		return s.computeGlobalRFStats(f)
	}
	return cachedAnalytics(s, "globalRF", func() GlobalRF { return s.computeGlobalRFStats(AnalyticsFilter{}) })
}

func (s *Store) computeGlobalRFStats(f AnalyticsFilter) GlobalRF {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var rssi, snr []float64
	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		for _, o := range tx.Observations {
			if !f.obsOK(o) {
				continue
			}
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
	RSSI              []float64    `json:"rssi"`
	SNR               []float64    `json:"snr"`
	TotalObservations int          `json:"totalObservations"`
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
		if v < mn {
			mn = v
		}
		if v > mx {
			mx = v
		}
	}
	return FloatSummary{Avg: sum / float64(len(vals)), Min: mn, Max: mx}
}

// ActivityBuckets returns hourly packet counts for the last windowHours hours.
func (s *Store) ActivityBuckets(windowHours int, f AnalyticsFilter) []ActivityBucket {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if windowHours <= 0 {
		windowHours = 24
	}
	now := time.Now().UTC()
	start := now.Add(-time.Duration(windowHours) * time.Hour).Truncate(time.Hour)
	buckets := make(map[int64]int)
	for _, tx := range s.packets {
		if !f.regionOK(tx) {
			continue
		}
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

// TopNodes returns nodes sorted by advert count descending (the default), or by
// retransmit count when by == "retransmits", capped at limit. The second return
// value maps the returned nodes' pubKeys to their retransmit count for display.
func (s *Store) TopNodes(limit int, by string, f AnalyticsFilter) ([]*Node, map[string]int) {
	// Retransmit counts require a full packet scan, so only pay that cost when
	// the caller actually sorts by (or needs) them. Computed first — it takes its
	// own read lock — so we don't nest RLocks.
	retx := map[string]int{}
	if by == "retransmits" {
		retx = s.RetransmitCounts(f)
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	// When scoped, recompute advert counts from packets in range and return copies
	// (never mutate the shared store nodes).
	advCount := map[string]int{}
	if f.Active() {
		for pk, txs := range s.byNode {
			c := 0
			for _, tx := range txs {
				if f.txOK(tx) {
					c++
				}
			}
			advCount[pk] = c
		}
	}

	nodes := make([]*Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		if f.Active() {
			if !f.nodeGeoOK(n) {
				continue // strict geographic exclusion
			}
			nc := *n
			nc.AdvertCount = advCount[n.PubKey]
			nodes = append(nodes, &nc)
		} else {
			nodes = append(nodes, n)
		}
	}
	rank := func(n *Node) int {
		if by == "retransmits" {
			return retx[n.PubKey]
		}
		return n.AdvertCount
	}
	// simple selection sort (small dataset)
	for i := 0; i < len(nodes) && i < limit; i++ {
		best := i
		for j := i + 1; j < len(nodes); j++ {
			if rank(nodes[j]) > rank(nodes[best]) {
				best = j
			}
		}
		nodes[i], nodes[best] = nodes[best], nodes[i]
	}
	if limit < len(nodes) {
		nodes = nodes[:limit]
	}
	// Drop out-of-scope nodes (zero rank) when filtering.
	if f.Active() {
		end := len(nodes)
		for end > 0 && rank(nodes[end-1]) == 0 {
			end--
		}
		nodes = nodes[:end]
	}
	return nodes, retx
}

// RetransmitCounts returns, per node pubKey, the number of distinct packets in
// which the node appears as a relay (path) hop — i.e. packets it retransmitted.
func (s *Store) RetransmitCounts(f AnalyticsFilter) map[string]int {
	if f.Active() {
		return s.computeRetransmitCounts(f)
	}
	return cachedAnalytics(s, "retransmitCounts", func() map[string]int { return s.computeRetransmitCounts(AnalyticsFilter{}) })
}

func (s *Store) computeRetransmitCounts(f AnalyticsFilter) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Distinct hop lengths (in hex chars) present across all observed paths. A
	// path hop is a node's routing-hash prefix, usually a single byte.
	lengths := make(map[int]bool)
	for _, tx := range s.packets {
		for _, o := range tx.Observations {
			for _, h := range o.Path {
				if isHexHop(h) {
					lengths[len(h)] = true
				}
			}
		}
	}

	// Index node pubKeys by their leading hex prefix at every observed hop length
	// so a hop can be matched to candidate nodes without scanning every node. A
	// short hop may collide with several pubKeys; each candidate is credited,
	// which is the inherent limit of matching by hash prefix.
	prefixIndex := make(map[string][]string)
	for pk := range s.nodes {
		lpk := strings.ToLower(pk)
		for l := range lengths {
			if len(lpk) >= l {
				prefixIndex[lpk[:l]] = append(prefixIndex[lpk[:l]], pk)
			}
		}
	}

	counts := make(map[string]int)
	credited := make(map[string]bool)
	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		// Count each node at most once per packet, even if several observers
		// reported the same path or the node appears in multiple observations.
		for k := range credited {
			delete(credited, k)
		}
		for _, o := range tx.Observations {
			for _, h := range o.Path {
				if !isHexHop(h) {
					continue
				}
				for _, pk := range prefixIndex[strings.ToLower(h)] {
					if !credited[pk] {
						credited[pk] = true
						counts[pk]++
					}
				}
			}
		}
	}
	return counts
}

// TopObservers returns observers sorted by packet count descending, capped at limit.
func (s *Store) TopObservers(limit int, f AnalyticsFilter) []*Observer {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// When scoped, recompute per-observer counts from observations in range and
	// return copies; otherwise use the stored cumulative PktCount.
	scoped := map[string]int{}
	if f.Active() {
		for _, tx := range s.packets {
			if !f.txOK(tx) {
				continue
			}
			for _, o := range tx.Observations {
				if f.obsOK(o) {
					scoped[o.ObserverID]++
				}
			}
		}
	}

	obs := make([]*Observer, 0, len(s.observers))
	for _, o := range s.observers {
		if f.Active() {
			c := scoped[o.ID]
			if c == 0 {
				continue
			}
			oc := *o
			oc.PktCount = c
			obs = append(obs, &oc)
		} else {
			obs = append(obs, o)
		}
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
			typeCounts[decoder.PayloadName(tx.PayloadType)]++
		}
	}

	var timeline []ActivityBucket
	for i := range windowHours {
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
func (s *Store) PacketsByType(f AnalyticsFilter) map[string]int {
	if f.Active() {
		return s.computePacketsByType(f)
	}
	return cachedAnalytics(s, "packetsByType", func() map[string]int { return s.computePacketsByType(AnalyticsFilter{}) })
}

func (s *Store) computePacketsByType(f AnalyticsFilter) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int)
	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		out[decoder.PayloadName(tx.PayloadType)]++
	}
	return out
}

// helpers

func txFromRow(r *db.TxRow) *Tx {
	t := &Tx{
		ID: r.ID, RawHex: r.RawHex, Hash: r.Hash, FirstSeen: r.FirstSeen,
		RouteType: r.RouteType, PayloadType: r.PayloadType, DecodedJSON: r.DecodedJSON,
		ObsCount: r.ObsCount, ChannelHash: r.ChannelHash,
	}
	// Decode once here, under the write lock held by Load/AddTxBatch, so that
	// Tx.Decoded() is a race-free pure getter for read-lock holders.
	json.Unmarshal([]byte(t.DecodedJSON), &t.DecodedPayload) //nolint:errcheck
	return t
}

func obsFromRow(r *db.ObsRow) *Obs {
	o := &Obs{
		ID: r.ID, TxID: r.TxID, ObserverID: r.ObserverID, ObserverName: r.ObserverName,
		ObserverIATA: r.ObserverIATA, RSSI: r.RSSI, SNR: r.SNR, Score: r.Score,
		Direction: r.Direction, PathJSON: r.PathJSON, FloodScope: r.FloodScope, Timestamp: r.Timestamp,
		RawHex: r.RawHex,
	}
	// Decode the hop path once here (under the store write lock held by
	// Load/AddTxBatch) so every analytics pass reads o.Path instead of
	// re-unmarshalling the JSON string on each request.
	json.Unmarshal([]byte(r.PathJSON), &o.Path) //nolint:errcheck
	return o
}

func nodeFromRow(r *db.NodeRow) *Node {
	n := &Node{
		PubKey: r.PubKey, Name: r.Name, Role: r.Role, Lat: r.Lat, Lon: r.Lon,
		LastSeen: r.LastSeen, FirstSeen: r.FirstSeen, AdvertCount: r.AdvertCount,
		BatteryMv: r.BatteryMv, TempC: r.TempC,
	}
	if r.Lat != nil && r.Lon != nil {
		n.Country = geo.CountryAt(*r.Lat, *r.Lon)
	}
	return n
}

func observerFromRow(r *db.ObserverRow) *Observer {
	return &Observer{
		ID: r.ID, Name: r.Name, IATA: r.IATA, LastSeen: r.LastSeen, FirstSeen: r.FirstSeen,
		PktCount: r.PktCount, Model: r.Model, Firmware: r.Firmware,
		BatteryMv: r.BatteryMv, UptimeSecs: r.UptimeSecs, NoiseFloor: r.NoiseFloor,
	}
}

// SNRByPayloadType returns average SNR and observation count per payload type name.
func (s *Store) SNRByPayloadType(f AnalyticsFilter) map[string]SNRTypeStat {
	if f.Active() {
		return s.computeSNRByPayloadType(f)
	}
	return cachedAnalytics(s, "snrByType", func() map[string]SNRTypeStat { return s.computeSNRByPayloadType(AnalyticsFilter{}) })
}

func (s *Store) computeSNRByPayloadType(f AnalyticsFilter) map[string]SNRTypeStat {
	s.mu.RLock()
	defer s.mu.RUnlock()
	type acc struct {
		sum   float64
		count int
	}
	byType := make(map[string]*acc)
	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		name := decoder.PayloadName(tx.PayloadType)
		for _, o := range tx.Observations {
			if o.SNR == nil || !f.obsOK(o) {
				continue
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
func (s *Store) HashStats(f AnalyticsFilter) HashStatsData {
	if f.Active() {
		return s.computeHashStats(f)
	}
	return cachedAnalytics(s, "hashStats", func() HashStatsData { return s.computeHashStats(AnalyticsFilter{}) })
}

func (s *Store) computeHashStats(f AnalyticsFilter) HashStatsData {
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

	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		for _, o := range tx.Observations {
			if !f.obsOK(o) {
				continue
			}
			hops := o.Path
			if len(hops) == 0 {
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
	for i := range days {
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
		SizeDistribution:   sizeDist,
		ByRole:             byRole,
		OverTime:           overTime,
		MultiByteAdopters:  adopterList,
		InconsistentHashes: s.computeInconsistentHashes(now),
	}
}

// computeInconsistentHashes finds repeaters and room servers whose adverts used
// more than one self-hash byte size within the last 7 days — the symptom of the
// firmware bug (MeshCore fcfdc5f) where automatic adverts ignored the configured
// multibyte path setting. Companion (and other) roles are excluded. Caller must
// hold the read lock.
func (s *Store) computeInconsistentHashes(now time.Time) []InconsistentHashNode {
	const days = 7
	start := now.AddDate(0, 0, -days)

	out := make([]InconsistentHashNode, 0)
	for pk, n := range s.nodes {
		if n.Role != "repeater" && n.Role != "room" {
			continue
		}
		sizesSeen := make(map[int]bool)
		currentSize := 0
		var currentSeen time.Time
		for _, tx := range s.byNode[pk] {
			if tx.PayloadType != 4 { // ADVERT
				continue
			}
			t := parseTimeToTime(tx.FirstSeen)
			if t.IsZero() || t.Before(start) {
				continue
			}
			size := advertSelfHashSize(tx, pk)
			if size == 0 {
				continue
			}
			sizesSeen[size] = true
			if t.After(currentSeen) {
				currentSeen, currentSize = t, size
			}
		}
		if len(sizesSeen) < 2 {
			continue
		}
		sizes := make([]int, 0, len(sizesSeen))
		for sz := range sizesSeen {
			sizes = append(sizes, sz)
		}
		sort.Ints(sizes)
		out = append(out, InconsistentHashNode{
			PubKey:      pk,
			Name:        n.Name,
			Role:        n.Role,
			CurrentHash: strings.ToUpper(pk[:min(currentSize*2, len(pk))]),
			CurrentSize: currentSize,
			SizesSeen:   sizes,
		})
	}
	// Most distinct sizes first (worst offenders), then alphabetically by name.
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].SizesSeen) != len(out[j].SizesSeen) {
			return len(out[i].SizesSeen) > len(out[j].SizesSeen)
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// advertSelfHashSize returns the byte size of a node's own routing hash within
// one of its adverts, located by finding the path hop that prefixes the node's
// pubKey. Returns 0 when no self-hash hop is present.
func advertSelfHashSize(tx *Tx, pubKey string) int {
	pkLower := strings.ToLower(pubKey)
	for _, o := range tx.Observations {
		for _, hop := range o.Path {
			if isHexHop(hop) && strings.HasPrefix(pkLower, strings.ToLower(hop)) {
				return len(hop) / 2
			}
		}
	}
	return 0
}

type HashStatsData struct {
	SizeDistribution   map[string]int            `json:"sizeDistribution"`
	ByRole             map[string]map[string]int `json:"byRole"`
	OverTime           []HashTimeBucket          `json:"overTime"`
	MultiByteAdopters  []HashAdopter             `json:"multiByteAdopters"`
	InconsistentHashes []InconsistentHashNode    `json:"inconsistentHashes"`
}

// InconsistentHashNode is a repeater/room server that advertised its routing
// hash at more than one byte size in the trailing 7-day window.
type InconsistentHashNode struct {
	PubKey      string `json:"pubKey"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	CurrentHash string `json:"currentHash"` // pubKey prefix at the latest advertised size, uppercase
	CurrentSize int    `json:"currentSize"` // bytes
	SizesSeen   []int  `json:"sizesSeen"`   // sorted distinct byte sizes seen
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

// ── Scope Analytics ───────────────────────────────────────────────────────────

// ScopeStats computes per-scope packet counts, RF quality, top observers, and
// hourly activity for the last 24 hours, derived from the flood_scope field on
// observations.
func (s *Store) ScopeStats(f AnalyticsFilter) ScopeStatsData {
	if f.Active() {
		return s.computeScopeStats(f)
	}
	return cachedAnalytics(s, "scopeStats", func() ScopeStatsData { return s.computeScopeStats(AnalyticsFilter{}) })
}

func (s *Store) computeScopeStats(f AnalyticsFilter) ScopeStatsData {
	s.mu.RLock()
	defer s.mu.RUnlock()

	const unknownScope = "unknown"

	// scope → set of txIDs (for deduped packet count)
	pktByScope := make(map[string]map[int64]bool)
	// scope → observation count
	obsCntByScope := make(map[string]int)
	// scope → RF accumulators
	type rfAcc struct {
		snrSum, rssiSum float64
		snrN, rssiN     int
	}
	rfAccByScope := make(map[string]*rfAcc)
	// (scope, observerID) → count
	type obsKey struct{ scope, id string }
	obsByKey := make(map[obsKey]int)
	obsInfoOf := make(map[string][2]string) // observerID → [name, iata]
	// 24h hourly activity: bucket unix → scope → count
	const windowHours = 24
	now := time.Now().UTC()
	actStart := now.Add(-windowHours * time.Hour).Truncate(time.Hour)
	activity := make(map[int64]map[string]int)

	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		for _, o := range tx.Observations {
			if !f.obsOK(o) {
				continue
			}
			sc := o.FloodScope
			if sc == "" {
				sc = unknownScope
			}

			if pktByScope[sc] == nil {
				pktByScope[sc] = make(map[int64]bool)
			}
			pktByScope[sc][o.TxID] = true
			obsCntByScope[sc]++

			if rfAccByScope[sc] == nil {
				rfAccByScope[sc] = &rfAcc{}
			}
			a := rfAccByScope[sc]
			if o.SNR != nil {
				a.snrSum += *o.SNR
				a.snrN++
			}
			if o.RSSI != nil {
				a.rssiSum += *o.RSSI
				a.rssiN++
			}

			k := obsKey{sc, o.ObserverID}
			obsByKey[k]++
			obsInfoOf[o.ObserverID] = [2]string{o.ObserverName, o.ObserverIATA}

			if t := parseTimeToTime(o.Timestamp); !t.IsZero() && !t.Before(actStart) {
				bucket := t.Truncate(time.Hour).Unix()
				if activity[bucket] == nil {
					activity[bucket] = make(map[string]int)
				}
				activity[bucket][sc]++
			}
		}
	}

	// Distribution
	dist := make([]ScopeBucket, 0, len(pktByScope))
	for sc, txSet := range pktByScope {
		dist = append(dist, ScopeBucket{
			Scope:    sc,
			PktCount: len(txSet),
			ObsCount: obsCntByScope[sc],
		})
	}
	sort.Slice(dist, func(i, j int) bool { return dist[i].PktCount > dist[j].PktCount })

	// RF by scope
	rfList := make([]ScopeRF, 0, len(rfAccByScope))
	for sc, a := range rfAccByScope {
		r := ScopeRF{Scope: sc, ObsCount: obsCntByScope[sc]}
		if a.snrN > 0 {
			r.AvgSNR = a.snrSum / float64(a.snrN)
		}
		if a.rssiN > 0 {
			r.AvgRSSI = a.rssiSum / float64(a.rssiN)
		}
		rfList = append(rfList, r)
	}
	sort.Slice(rfList, func(i, j int) bool { return rfList[i].ObsCount > rfList[j].ObsCount })

	// Top observers per scope (top 5 each)
	byScope := make(map[string][]ScopeObserver)
	for k, cnt := range obsByKey {
		info := obsInfoOf[k.id]
		byScope[k.scope] = append(byScope[k.scope], ScopeObserver{
			Scope: k.scope, ObserverID: k.id, ObserverName: info[0], ObserverIATA: info[1], Count: cnt,
		})
	}
	var topObs []ScopeObserver
	for _, list := range byScope {
		sort.Slice(list, func(i, j int) bool { return list[i].Count > list[j].Count })
		if len(list) > 5 {
			list = list[:5]
		}
		topObs = append(topObs, list...)
	}
	sort.Slice(topObs, func(i, j int) bool {
		if topObs[i].Scope != topObs[j].Scope {
			return topObs[i].Scope < topObs[j].Scope
		}
		return topObs[i].Count > topObs[j].Count
	})

	// Collect scope names present in activity for the legend
	actScopeSet := make(map[string]bool)
	for _, bkt := range activity {
		for sc := range bkt {
			actScopeSet[sc] = true
		}
	}
	actScopes := make([]string, 0, len(actScopeSet))
	for sc := range actScopeSet {
		actScopes = append(actScopes, sc)
	}
	sort.Strings(actScopes)

	hours := make([]ScopeHour, windowHours)
	for i := range windowHours {
		h := actStart.Add(time.Duration(i) * time.Hour)
		counts := make(map[string]int)
		if bkt := activity[h.Unix()]; bkt != nil {
			maps.Copy(counts, bkt)
		}
		hours[i] = ScopeHour{Hour: h.Format(time.RFC3339), Label: h.Format("15:04"), Counts: counts}
	}

	return ScopeStatsData{
		Distribution:   dist,
		RFByScope:      rfList,
		TopObservers:   topObs,
		ActivityScopes: actScopes,
		Activity:       hours,
	}
}

type ScopeStatsData struct {
	Distribution   []ScopeBucket   `json:"distribution"`
	RFByScope      []ScopeRF       `json:"rfByScope"`
	TopObservers   []ScopeObserver `json:"topObservers"`
	ActivityScopes []string        `json:"activityScopes"`
	Activity       []ScopeHour     `json:"activity"`
}

type ScopeBucket struct {
	Scope    string `json:"scope"`
	PktCount int    `json:"pktCount"`
	ObsCount int    `json:"obsCount"`
}

type ScopeRF struct {
	Scope    string  `json:"scope"`
	AvgSNR   float64 `json:"avgSnr"`
	AvgRSSI  float64 `json:"avgRssi"`
	ObsCount int     `json:"obsCount"`
}

type ScopeObserver struct {
	Scope        string `json:"scope"`
	ObserverID   string `json:"observerId"`
	ObserverName string `json:"observerName"`
	ObserverIATA string `json:"observerIata"`
	Count        int    `json:"count"`
}

type ScopeHour struct {
	Hour   string         `json:"hour"`
	Label  string         `json:"label"`
	Counts map[string]int `json:"counts"`
}

// ── Distance / Hop Analytics ──────────────────────────────────────────────────

// DistanceStats analyses hop-count "distance" across all observations.
// "Distance" here is the number of intermediate relay hops a packet traversed.
func (s *Store) DistanceStats(f AnalyticsFilter) DistanceStatsData {
	if f.Active() {
		return s.computeDistanceStats(f)
	}
	return cachedAnalytics(s, "distanceStats", func() DistanceStatsData { return s.computeDistanceStats(AnalyticsFilter{}) })
}

func (s *Store) computeDistanceStats(f AnalyticsFilter) DistanceStatsData {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var totalHops, pathsAnalyzed, maxHopDist int
	var direct, singleRelay, multiRelay int
	hopDistMap := make(map[int]int) // hopCount → frequency (all obs)

	const windowHours = 24
	now := time.Now().UTC()
	actStart := now.Add(-windowHours * time.Hour).Truncate(time.Hour)
	type actAcc struct{ hopSum, count int }
	actBuckets := make(map[int64]*actAcc)

	// Collect per-observation entries for top-N sorting
	type hopObsEntry struct {
		hash, firstSeen            string
		hopCount                   int
		hops                       []string
		observerName, observerIATA string
		routeType, payloadType     int
	}
	var allObsEntries []hopObsEntry

	// Per-packet best-hop tracking for top paths
	type txBest struct {
		hash, firstSeen        string
		maxHops                int
		bestPath               []string
		routeType, payloadType int
		obsCount               int
	}
	txBestMap := make(map[int64]*txBest)

	for _, tx := range s.packets {
		if !f.txOK(tx) {
			continue
		}
		for _, o := range tx.Observations {
			if !f.obsOK(o) {
				continue
			}
			var hops []string
			for _, h := range o.Path {
				if isHexHop(h) {
					hops = append(hops, h)
				}
			}
			hopCount := len(hops)

			// Link type (all observations)
			switch {
			case hopCount == 0:
				direct++
			case hopCount == 1:
				singleRelay++
			default:
				multiRelay++
			}
			hopDistMap[hopCount]++

			// Metrics for non-empty paths only
			if hopCount > 0 {
				pathsAnalyzed++
				totalHops += hopCount
				if hopCount > maxHopDist {
					maxHopDist = hopCount
				}
			}

			// Hourly activity (all observations, avg includes 0-hop)
			if t := parseTimeToTime(o.Timestamp); !t.IsZero() && !t.Before(actStart) {
				bucket := t.Truncate(time.Hour).Unix()
				if actBuckets[bucket] == nil {
					actBuckets[bucket] = &actAcc{}
				}
				actBuckets[bucket].hopSum += hopCount
				actBuckets[bucket].count++
			}

			allObsEntries = append(allObsEntries, hopObsEntry{
				hash: tx.Hash, firstSeen: tx.FirstSeen,
				hopCount: hopCount, hops: hops,
				observerName: o.ObserverName, observerIATA: o.ObserverIATA,
				routeType: tx.RouteType, payloadType: tx.PayloadType,
			})

			if e, ok := txBestMap[tx.ID]; ok {
				e.obsCount++
				if hopCount > e.maxHops {
					e.maxHops = hopCount
					e.bestPath = hops
				}
			} else {
				txBestMap[tx.ID] = &txBest{
					hash: tx.Hash, firstSeen: tx.FirstSeen,
					maxHops: hopCount, bestPath: hops,
					routeType: tx.RouteType, payloadType: tx.PayloadType,
					obsCount: 1,
				}
			}
		}
	}

	avgHopDist := 0.0
	if pathsAnalyzed > 0 {
		avgHopDist = float64(totalHops) / float64(pathsAnalyzed)
	}

	// Hop distribution buckets (0-hop up to maxHopDist)
	maxBucket := 0
	for k := range hopDistMap {
		if k > maxBucket {
			maxBucket = k
		}
	}
	hopDist := make([]HopDistBucket, maxBucket+1)
	for i := 0; i <= maxBucket; i++ {
		hopDist[i] = HopDistBucket{Hops: i, Count: hopDistMap[i]}
	}

	// Hourly activity
	actHours := make([]HopActivity, windowHours)
	for i := range windowHours {
		h := actStart.Add(time.Duration(i) * time.Hour)
		a := HopActivity{Hour: h.Format(time.RFC3339), Label: h.Format("15:04")}
		if bkt := actBuckets[h.Unix()]; bkt != nil && bkt.count > 0 {
			a.AvgHops = float64(bkt.hopSum) / float64(bkt.count)
			a.Count = bkt.count
		}
		actHours[i] = a
	}

	// Top 20 longest hops (per observation, descending)
	sort.Slice(allObsEntries, func(i, j int) bool { return allObsEntries[i].hopCount > allObsEntries[j].hopCount })
	if len(allObsEntries) > 20 {
		allObsEntries = allObsEntries[:20]
	}
	top20 := make([]LongHop, len(allObsEntries))
	for i, e := range allObsEntries {
		top20[i] = LongHop{
			Hash: e.hash, FirstSeen: e.firstSeen,
			HopCount: e.hopCount, Hops: e.hops,
			ObserverName: e.observerName, ObserverIATA: e.observerIATA,
			RouteType: e.routeType, PayloadType: e.payloadType,
		}
	}

	// Top 10 multi-hop paths (per unique packet, ≥2 hops preferred then ≥1)
	pathList := make([]txBest, 0, len(txBestMap))
	for _, e := range txBestMap {
		if e.maxHops >= 2 {
			pathList = append(pathList, *e)
		}
	}
	sort.Slice(pathList, func(i, j int) bool { return pathList[i].maxHops > pathList[j].maxHops })
	if len(pathList) > 10 {
		pathList = pathList[:10]
	}
	top10 := make([]LongPath, len(pathList))
	for i, e := range pathList {
		top10[i] = LongPath{
			Hash: e.hash, FirstSeen: e.firstSeen,
			MaxHops: e.maxHops, BestPath: e.bestPath,
			RouteType: e.routeType, PayloadType: e.payloadType,
			ObsCount: e.obsCount,
		}
	}

	return DistanceStatsData{
		TotalHops:       totalHops,
		PathsAnalyzed:   pathsAnalyzed,
		AvgHopDist:      avgHopDist,
		MaxHopDist:      maxHopDist,
		ByLinkType:      DistLinkTypes{Direct: direct, SingleRelay: singleRelay, MultiRelay: multiRelay},
		HopDistribution: hopDist,
		ActivityByHour:  actHours,
		Top20Hops:       top20,
		Top10MultiHop:   top10,
		Geo:             s.geoDistStats(),
	}
}

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// geoDistStats computes pairwise Haversine distances for all nodes with known coordinates.
// Called under the read lock already held by DistanceStats.
func (s *Store) geoDistStats() GeoDistData {
	type geoNode struct {
		pubKey, name string
		lat, lon     float64
	}
	var nodes []geoNode
	for _, n := range s.nodes {
		if n.Lat == nil || n.Lon == nil {
			continue
		}
		nodes = append(nodes, geoNode{pubKey: n.PubKey, name: n.Name, lat: *n.Lat, lon: *n.Lon})
	}

	totalNodes := len(nodes)
	if totalNodes < 2 {
		return GeoDistData{NodesWithPos: totalNodes}
	}

	var totalKm float64
	var maxKm float64
	pairCount := 0
	distBuckets := make(map[int]int) // bucket lower bound (km) → count

	// Keep only the longest pairs (sorted desc) rather than materializing every
	// O(N²) pair — the previous version appended all of them before truncating.
	const topN = 15
	topPairs := make([]GeoNodePair, 0, topN+1)

	for i := 0; i < len(nodes); i++ {
		for j := i + 1; j < len(nodes); j++ {
			d := haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon)
			pairCount++
			totalKm += d
			if d > maxKm {
				maxKm = d
			}
			// Bucket: 0-1, 1-5, 5-10, 10-25, 25-50, 50-100, 100-250, 250-500, 500+
			var b int
			switch {
			case d < 1:
				b = 0
			case d < 5:
				b = 1
			case d < 10:
				b = 5
			case d < 25:
				b = 10
			case d < 50:
				b = 25
			case d < 100:
				b = 50
			case d < 250:
				b = 100
			case d < 500:
				b = 250
			default:
				b = 500
			}
			distBuckets[b]++

			dk := math.Round(d*100) / 100
			if len(topPairs) < topN || dk > topPairs[len(topPairs)-1].DistKm {
				pair := GeoNodePair{
					NodeAName: nodes[i].name, NodeAPubKey: nodes[i].pubKey,
					NodeBName: nodes[j].name, NodeBPubKey: nodes[j].pubKey,
					DistKm: dk,
				}
				pos := sort.Search(len(topPairs), func(k int) bool { return topPairs[k].DistKm < dk })
				topPairs = append(topPairs, GeoNodePair{})
				copy(topPairs[pos+1:], topPairs[pos:])
				topPairs[pos] = pair
				if len(topPairs) > topN {
					topPairs = topPairs[:topN]
				}
			}
		}
	}

	avgKm := totalKm / float64(pairCount)

	// Build ordered distribution
	bucketOrder := []int{0, 1, 5, 10, 25, 50, 100, 250, 500}
	bucketLabels := map[int]string{
		0: "< 1 km", 1: "1–5 km", 5: "5–10 km", 10: "10–25 km",
		25: "25–50 km", 50: "50–100 km", 100: "100–250 km", 250: "250–500 km", 500: "≥ 500 km",
	}
	var dist []GeoDistBucket
	for _, b := range bucketOrder {
		if c := distBuckets[b]; c > 0 {
			dist = append(dist, GeoDistBucket{Label: bucketLabels[b], Count: c})
		}
	}

	return GeoDistData{
		NodesWithPos: totalNodes,
		TotalPairs:   pairCount,
		MaxDistKm:    math.Round(maxKm*100) / 100,
		AvgDistKm:    math.Round(avgKm*100) / 100,
		Distribution: dist,
		TopPairs:     topPairs,
	}
}

type GeoDistData struct {
	NodesWithPos int             `json:"nodesWithPos"`
	TotalPairs   int             `json:"totalPairs"`
	MaxDistKm    float64         `json:"maxDistKm"`
	AvgDistKm    float64         `json:"avgDistKm"`
	Distribution []GeoDistBucket `json:"distribution"`
	TopPairs     []GeoNodePair   `json:"topPairs"`
}

type GeoDistBucket struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type GeoNodePair struct {
	NodeAName   string  `json:"nodeAName"`
	NodeAPubKey string  `json:"nodeAPubKey"`
	NodeBName   string  `json:"nodeBName"`
	NodeBPubKey string  `json:"nodeBPubKey"`
	DistKm      float64 `json:"distKm"`
}

type DistanceStatsData struct {
	TotalHops       int             `json:"totalHops"`
	PathsAnalyzed   int             `json:"pathsAnalyzed"`
	AvgHopDist      float64         `json:"avgHopDist"`
	MaxHopDist      int             `json:"maxHopDist"`
	ByLinkType      DistLinkTypes   `json:"byLinkType"`
	HopDistribution []HopDistBucket `json:"hopDistribution"`
	ActivityByHour  []HopActivity   `json:"activityByHour"`
	Top20Hops       []LongHop       `json:"top20Hops"`
	Top10MultiHop   []LongPath      `json:"top10MultiHop"`
	Geo             GeoDistData     `json:"geo"`
}

type DistLinkTypes struct {
	Direct      int `json:"direct"`
	SingleRelay int `json:"singleRelay"`
	MultiRelay  int `json:"multiRelay"`
}

type HopDistBucket struct {
	Hops  int `json:"hops"`
	Count int `json:"count"`
}

type HopActivity struct {
	Hour    string  `json:"hour"`
	Label   string  `json:"label"`
	AvgHops float64 `json:"avgHops"`
	Count   int     `json:"count"`
}

type LongHop struct {
	Hash         string   `json:"hash"`
	FirstSeen    string   `json:"firstSeen"`
	HopCount     int      `json:"hopCount"`
	Hops         []string `json:"hops"`
	ObserverName string   `json:"observerName"`
	ObserverIATA string   `json:"observerIata"`
	RouteType    int      `json:"routeType"`
	PayloadType  int      `json:"payloadType"`
}

type LongPath struct {
	Hash        string   `json:"hash"`
	FirstSeen   string   `json:"firstSeen"`
	MaxHops     int      `json:"maxHops"`
	BestPath    []string `json:"bestPath"`
	RouteType   int      `json:"routeType"`
	PayloadType int      `json:"payloadType"`
	ObsCount    int      `json:"obsCount"`
}
