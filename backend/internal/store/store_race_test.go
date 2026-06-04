package store

import (
	"sync"
	"testing"

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
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				pkts, _ := s.Packets(50, 0)
				for _, p := range pkts {
					_ = p.Decoded() // pure read; must not race
				}
			}
		}()
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
// serves a memoized value and recomputes after a mutation.
func TestAnalyticsCacheInvalidation(t *testing.T) {
	s := New()
	s.Load([]*db.TxRow{
		{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil, nil, nil)

	first := s.PacketsByType()
	if first["ADVERT"] != 1 {
		t.Fatalf("expected 1 ADVERT, got %v", first)
	}
	// Same version → cached (must equal, and map identity reused).
	if got := s.PacketsByType(); got["ADVERT"] != 1 {
		t.Fatalf("cached call diverged: %v", got)
	}

	// Mutate → version bumps → recompute reflects the new packet.
	s.AddTxBatch([]*db.TxRow{
		{ID: 2, Hash: "b", RawHex: "01", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4, DecodedJSON: `{"type":"ADVERT"}`},
	}, nil)
	if got := s.PacketsByType(); got["ADVERT"] != 2 {
		t.Fatalf("expected cache invalidation to yield 2 ADVERT, got %v", got)
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
