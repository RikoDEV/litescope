package store

import (
	"sync"
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
)

// TestDecodedConcurrentReads guards against the data race that existed when
// Tx.Decoded() memoized lazily under a read lock. With eager decoding in
// txFromRow, concurrent readers must observe a stable, race-free map.
// Run with: go test -race ./internal/store/
func TestDecodedConcurrentReads(t *testing.T) {
	s := New()
	txs := []*db.TxRow{
		{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", DecodedJSON: `{"pubKey":"abc","type":"ADVERT"}`},
		{ID: 2, Hash: "b", RawHex: "01", FirstSeen: "2024-01-01T00:00:01Z", DecodedJSON: `{"channel":"Public","type":"CHAN"}`},
		{ID: 3, Hash: "c", RawHex: "02", FirstSeen: "2024-01-01T00:00:02Z", DecodedJSON: ``}, // empty → nil map
	}
	s.Load(txs, nil, nil, nil)

	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			for range 200 {
				pkts, _ := s.Packets(50, 0)
				for _, p := range pkts {
					_ = p.Decoded() // pure read; must not race
				}
			}
		})
	}
	wg.Wait()

	if got := s.byHash["a"].Decoded()["pubKey"]; got != "abc" {
		t.Fatalf("expected decoded pubKey abc, got %v", got)
	}
	if s.byHash["c"].Decoded() != nil {
		t.Fatalf("expected nil decoded map for empty JSON")
	}
}

// TestAnalyticsCacheInvalidation verifies the version-keyed analytics cache
// serves a memoized value and recomputes after a mutation once the staleness
// budget is disabled (TTL=0 → version is the sole gate).
func TestAnalyticsCacheInvalidation(t *testing.T) {
	defer withCacheTTL(0)()

	s := New()
	s.Load([]*db.TxRow{
		{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil, nil, nil)

	first := s.PacketsByType(AnalyticsFilter{})
	if first["ADVERT"] != 1 {
		t.Fatalf("expected 1 ADVERT, got %v", first)
	}
	// Same version → cached (must equal, and map identity reused).
	if got := s.PacketsByType(AnalyticsFilter{}); got["ADVERT"] != 1 {
		t.Fatalf("cached call diverged: %v", got)
	}

	// Mutate → version bumps → recompute reflects the new packet.
	s.AddTxBatch([]*db.TxRow{
		{ID: 2, Hash: "b", RawHex: "01", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil)
	if got := s.PacketsByType(AnalyticsFilter{}); got["ADVERT"] != 2 {
		t.Fatalf("expected cache invalidation to yield 2 ADVERT, got %v", got)
	}
}

// TestAnalyticsCacheTTL verifies that within the staleness budget a memoized
// result is reused even after the underlying data (and version) changed — the
// throttle that keeps heavy analytics from recomputing on every request of a
// busy network.
func TestAnalyticsCacheTTL(t *testing.T) {
	defer withCacheTTL(time.Hour)()

	s := New()
	s.Load([]*db.TxRow{
		{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil, nil, nil)

	if got := s.PacketsByType(AnalyticsFilter{}); got["ADVERT"] != 1 {
		t.Fatalf("expected 1 ADVERT, got %v", got)
	}
	// Mutate: version bumps, but the cached value is fresh → still served stale.
	s.AddTxBatch([]*db.TxRow{
		{ID: 2, Hash: "b", RawHex: "01", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil)
	if got := s.PacketsByType(AnalyticsFilter{}); got["ADVERT"] != 1 {
		t.Fatalf("expected throttled cache to still report 1 ADVERT, got %v", got)
	}
}

// withCacheTTL temporarily overrides analyticsCacheTTL, returning a restore func.
func withCacheTTL(d time.Duration) func() {
	prev := analyticsCacheTTL
	analyticsCacheTTL = d
	return func() { analyticsCacheTTL = prev }
}

// TestPrune verifies retention drops old packets from every index while leaving
// recent ones (and their relay/node lookups) intact.
func TestPrune(t *testing.T) {
	s := New()
	old := "2024-01-01T00:00:00Z"
	recent := time.Now().UTC().Format(time.RFC3339)
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "old", RawHex: "00", FirstSeen: old, PayloadType: 4, DecodedJSON: `{"pubKey":"nodeOld","type":"ADVERT"}`},
			{ID: 2, Hash: "new", RawHex: "01", FirstSeen: recent, PayloadType: 4, DecodedJSON: `{"pubKey":"nodeNew","type":"ADVERT"}`},
		},
		[]*db.ObsRow{
			{ID: 1, TxID: 1, ObserverID: "obsA", PathJSON: `["ab","cd"]`},
			{ID: 2, TxID: 2, ObserverID: "obsA", PathJSON: `["ef"]`},
		},
		nil, nil,
	)

	cutoff := time.Now().UTC().Add(-24 * time.Hour).UnixMilli()
	if n := s.Prune(cutoff); n != 1 {
		t.Fatalf("expected 1 pruned, got %d", n)
	}

	if _, total := s.Packets(50, 0); total != 1 {
		t.Fatalf("expected 1 packet remaining, got %d", total)
	}
	if s.PacketByHash("old") != nil {
		t.Fatalf("old packet still present by hash")
	}
	if s.PacketByHash("new") == nil {
		t.Fatalf("recent packet was wrongly pruned")
	}
	// Relay index for the pruned packet's hop must be gone; the recent one kept.
	if got := s.NodePackets("ab00000000", 0); len(got) != 0 {
		t.Fatalf("pruned relay hop still indexed: %d packets", len(got))
	}
	if got := s.byObserver["obsA"]; len(got) != 1 {
		t.Fatalf("expected 1 observation left for obsA, got %d", len(got))
	}
	// nodeOld's only advert was pruned from byNode → no packets attributable to it.
	if got := s.NodePackets("nodeOld", 0); len(got) != 0 {
		t.Fatalf("pruned node still has packets: %d", len(got))
	}
}

// TestNodeRFStatsLivePackets guards the byNode index being maintained in
// AddTxBatch (not just Load) so a node's RF stats reflect packets ingested
// after startup.
func TestNodeRFStatsLivePackets(t *testing.T) {
	s := New()
	s.Load(nil, nil, nil, nil)

	rssi := -90.0
	snr := 5.5
	s.AddTxBatch(
		[]*db.TxRow{{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"pubKey":"nodeX","type":"ADVERT"}`}},
		[]*db.ObsRow{{ID: 1, TxID: 1, ObserverID: "obs1", RSSI: &rssi, SNR: &snr, PathJSON: "[]"}},
	)

	rf := s.NodeRFStats("nodeX")
	if len(rf.RSSI) != 1 || rf.RSSI[0] != -90.0 {
		t.Fatalf("expected RSSI [-90], got %v", rf.RSSI)
	}
	if len(rf.SNR) != 1 || rf.SNR[0] != 5.5 {
		t.Fatalf("expected SNR [5.5], got %v", rf.SNR)
	}
}

func TestHashMatrixShowsOnlyRepeaters(t *testing.T) {
	s := New()
	const repeater = "aa11000000000000000000000000000000000000000000000000000000000000"
	const companion = "aa22000000000000000000000000000000000000000000000000000000000000"
	const room = "aa33000000000000000000000000000000000000000000000000000000000000"
	const sensor = "aa44000000000000000000000000000000000000000000000000000000000000"
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "r", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + repeater + `"}`},
			{ID: 2, Hash: "c", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + companion + `"}`},
			{ID: 3, Hash: "room", FirstSeen: "2024-01-01T00:00:02Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + room + `"}`},
			{ID: 4, Hash: "s", FirstSeen: "2024-01-01T00:00:03Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + sensor + `"}`},
		},
		[]*db.ObsRow{
			{ID: 1, TxID: 1, ObserverID: "obs", PathJSON: `["AA"]`},
			{ID: 2, TxID: 2, ObserverID: "obs", PathJSON: `["AA"]`},
			{ID: 3, TxID: 3, ObserverID: "obs", PathJSON: `["AA"]`},
			{ID: 4, TxID: 4, ObserverID: "obs", PathJSON: `["AA"]`},
		},
		[]*db.NodeRow{
			{PubKey: repeater, Name: "Repeater", Role: "repeater"},
			{PubKey: companion, Name: "Companion", Role: "companion"},
			{PubKey: room, Name: "Room", Role: "room"},
			{PubKey: sensor, Name: "Sensor", Role: "sensor"},
		},
		nil,
	)

	matrix := s.HashStats(AnalyticsFilter{}).HashMatrices["1"]
	if matrix.TrackedNodes != 1 || matrix.RoutingNodes != 1 {
		t.Fatalf("expected only one repeater in matrix, got tracked=%d routing=%d", matrix.TrackedNodes, matrix.RoutingNodes)
	}
	cell := matrix.Cells[0xaa]
	if cell.State != "taken" || cell.NodeCount != 1 || cell.RoutingCount != 1 {
		t.Fatalf("unexpected repeater-only cell: state=%s node=%d routing=%d", cell.State, cell.NodeCount, cell.RoutingCount)
	}
	if got := cell.Groups[0].Nodes[0].Role; got != "repeater" {
		t.Fatalf("expected repeater only, got role %q", got)
	}
}

func TestHashMatrixRoutingCollisionBySelectedByteSize(t *testing.T) {
	s := New()
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "a", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"pubKey":"aa11000000000000000000000000000000000000000000000000000000000000"}`},
			{ID: 2, Hash: "b", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"pubKey":"aa22000000000000000000000000000000000000000000000000000000000000"}`},
		},
		[]*db.ObsRow{
			{ID: 1, TxID: 1, ObserverID: "obs", PathJSON: `["AA11"]`},
			{ID: 2, TxID: 2, ObserverID: "obs", PathJSON: `["AA22"]`},
		},
		[]*db.NodeRow{
			{PubKey: "aa11000000000000000000000000000000000000000000000000000000000000", Name: "Repeater A", Role: "repeater"},
			{PubKey: "aa22000000000000000000000000000000000000000000000000000000000000", Name: "Repeater B", Role: "repeater"},
		},
		nil,
	)

	stats := s.HashStats(AnalyticsFilter{})
	oneByte := stats.HashMatrices["1"].Cells[0xaa]
	if oneByte.State != "collision" || oneByte.CollisionCount != 2 {
		t.Fatalf("expected 1-byte repeater collision, got state=%s collisionCount=%d", oneByte.State, oneByte.CollisionCount)
	}
	twoByte := stats.HashMatrices["2"].Cells[0xaa]
	if twoByte.State != "taken" || twoByte.CollisionCount != 0 || twoByte.MaxGroup != 1 {
		t.Fatalf("expected distinct 2-byte prefixes, got state=%s collisionCount=%d maxGroup=%d", twoByte.State, twoByte.CollisionCount, twoByte.MaxGroup)
	}
	if got := twoByte.Groups[0].Nodes[0].CurrentSize; got != 2 {
		t.Fatalf("expected advert-derived current size 2, got %d", got)
	}
}

func TestHashMatrixUsesLatestAdvertHashAndCountsUnknownMode(t *testing.T) {
	s := New()
	const repeater = "aa11000000000000000000000000000000000000000000000000000000000000"
	const unknownRepeater = "bb22000000000000000000000000000000000000000000000000000000000000"
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "old", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + repeater + `"}`},
			{ID: 2, Hash: "new", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + repeater + `"}`},
		},
		[]*db.ObsRow{
			{ID: 1, TxID: 1, ObserverID: "obs", PathJSON: `["AA"]`},
			{ID: 2, TxID: 2, ObserverID: "obs", PathJSON: `["AA11"]`},
		},
		[]*db.NodeRow{
			{PubKey: repeater, Name: "Repeater", Role: "repeater"},
			{PubKey: unknownRepeater, Name: "Unknown", Role: "repeater"},
		},
		nil,
	)

	matrix := s.HashStats(AnalyticsFilter{}).HashMatrices["2"]
	if matrix.RoutingNodes != 2 {
		t.Fatalf("expected 2 repeaters, got %d", matrix.RoutingNodes)
	}
	if matrix.UnknownModeNodes != 1 {
		t.Fatalf("expected repeater with no self-hash advert to be unknown, got %d", matrix.UnknownModeNodes)
	}
	cell := matrix.Cells[0xaa]
	if cell.NodeCount != 1 || len(cell.Groups) != 1 || len(cell.Groups[0].Nodes) != 1 {
		t.Fatalf("unexpected AA cell shape: %+v", cell)
	}
	node := cell.Groups[0].Nodes[0]
	if node.CurrentSize != 2 || node.CurrentHash != "AA11" {
		t.Fatalf("expected latest 2-byte self hash AA11, got size=%d hash=%q", node.CurrentSize, node.CurrentHash)
	}
}

func TestHashMatrixNonRepeaterOverlapStaysHidden(t *testing.T) {
	s := New()
	const repeater = "cc11000000000000000000000000000000000000000000000000000000000000"
	const sensor = "cc11010000000000000000000000000000000000000000000000000000000000"
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "r", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + repeater + `"}`},
			{ID: 2, Hash: "s", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"pubKey":"` + sensor + `"}`},
		},
		[]*db.ObsRow{
			{ID: 1, TxID: 1, ObserverID: "obs", PathJSON: `["CC11"]`},
			{ID: 2, TxID: 2, ObserverID: "obs", PathJSON: `["CC11"]`},
		},
		[]*db.NodeRow{
			{PubKey: repeater, Name: "Repeater", Role: "repeater"},
			{PubKey: sensor, Name: "Sensor", Role: "sensor"},
		},
		nil,
	)

	cell := s.HashStats(AnalyticsFilter{}).HashMatrices["2"].Cells[0xcc]
	if cell.State != "taken" || cell.NodeCount != 1 || cell.CollisionCount != 0 || cell.RoutingCount != 1 {
		t.Fatalf("expected only repeater to be visible, got state=%s node=%d collision=%d routing=%d", cell.State, cell.NodeCount, cell.CollisionCount, cell.RoutingCount)
	}
	if got := cell.Groups[0].Nodes[0].PubKey; got != repeater {
		t.Fatalf("expected only repeater pubkey, got %q", got)
	}
}
