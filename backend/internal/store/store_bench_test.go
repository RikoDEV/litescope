package store

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
)

// Synthetic store for the analytics benchmarks: a few weeks of history on a
// busy network. Built once per test binary run (it's the expensive part).
//
//	go test ./internal/store/ -run '^$' -bench . -benchmem
const (
	benchTxs       = 200_000
	benchObsPerTx  = 5
	benchNodes     = 2_000
	benchObservers = 100
	benchDays      = 21
)

var (
	benchOnce  sync.Once
	benchStore *Store
)

func benchFixture() (txs []*db.TxRow, obss []*db.ObsRow, nodes []*db.NodeRow, observers []*db.ObserverRow) {
	r := rand.New(rand.NewPCG(1, 2))
	now := time.Now().UTC()
	iatas := []string{"SJC", "SFO", "OAK", "LAX", "SEA"}
	roles := []string{"repeater", "companion", "room"}

	pubKeys := make([]string, benchNodes)
	for i := range benchNodes {
		pk := fmt.Sprintf("%016x%016x%016x%016x", r.Uint64(), r.Uint64(), r.Uint64(), r.Uint64())
		pubKeys[i] = pk
		lat, lon := 37+r.Float64(), -122+r.Float64()
		nodes = append(nodes, &db.NodeRow{
			PubKey: pk, Name: fmt.Sprintf("node-%d", i), Role: roles[i%len(roles)],
			Lat: &lat, Lon: &lon, LastSeen: now.Format(time.RFC3339), FirstSeen: now.Add(-benchDays * 24 * time.Hour).Format(time.RFC3339),
		})
	}
	obsIDs := make([]string, benchObservers)
	for i := range benchObservers {
		obsIDs[i] = pubKeys[i*3] // observers double as (repeater) nodes
		observers = append(observers, &db.ObserverRow{ID: obsIDs[i], Name: fmt.Sprintf("obs-%d", i), IATA: iatas[i%len(iatas)], LastSeen: now.Format(time.RFC3339)})
	}

	span := int64(benchDays * 24 * time.Hour / time.Second)
	start := now.Add(-time.Duration(span) * time.Second)
	var obsID int64
	for i := range benchTxs {
		id := int64(i + 1)
		ts := start.Add(time.Duration(int64(i)*span/benchTxs) * time.Second)
		pt := []int{2, 4, 5, 8}[r.IntN(4)]
		dec := map[string]any{"type": "X"}
		if pt == 4 {
			dec["pubKey"] = pubKeys[r.IntN(benchNodes)]
			dec["name"] = "n"
			dec["timestampISO"] = ts.Add(-time.Duration(r.IntN(600)) * time.Second).Format(time.RFC3339)
		} else {
			dec["srcHash"] = pubKeys[r.IntN(benchNodes)][:2]
		}
		chHash := ""
		if pt == 5 {
			chHash = fmt.Sprintf("%02x", r.IntN(8))
			dec["channel"] = "Public"
			dec["decryptionStatus"] = "decrypted"
			dec["sender"] = fmt.Sprintf("s%d", r.IntN(200))
		}
		decJSON, _ := json.Marshal(dec)
		txs = append(txs, &db.TxRow{
			ID: id, Hash: fmt.Sprintf("h%d", id), RawHex: randHex(r, 60), FirstSeen: ts.Format(time.RFC3339),
			RouteType: r.IntN(4), PayloadType: pt, DecodedJSON: string(decJSON), ObsCount: benchObsPerTx, ChannelHash: chHash,
		})
		for range benchObsPerTx {
			obsID++
			hops := make([]string, r.IntN(5))
			for h := range hops {
				hops[h] = pubKeys[r.IntN(benchNodes)][:2]
			}
			pj, _ := json.Marshal(hops)
			o := obsIDs[r.IntN(benchObservers)]
			snr, rssi := r.Float64()*20-10, -120+r.Float64()*60
			obss = append(obss, &db.ObsRow{
				ID: obsID, TxID: id, ObserverID: o, ObserverName: "obs", ObserverIATA: iatas[r.IntN(len(iatas))],
				SNR: &snr, RSSI: &rssi, PathJSON: string(pj), FloodScope: []string{"", "#bay"}[r.IntN(2)],
				Timestamp: ts.Format(time.RFC3339), RawHex: randHex(r, 64),
			})
		}
	}
	return
}

func benchSetup(b *testing.B) *Store {
	b.Helper()
	benchOnce.Do(func() {
		txs, obss, nodes, observers := benchFixture()
		benchStore = New()
		benchStore.Load(txs, obss, nodes, observers)
	})
	b.ResetTimer()
	b.ReportAllocs()
	return benchStore
}

var benchAll = AnalyticsFilter{}

func bench24h() AnalyticsFilter { return NewAnalyticsFilter(24, nil, nil, false) }

func BenchmarkLoad(b *testing.B) {
	txs, obss, nodes, observers := benchFixture()
	b.ResetTimer()
	b.ReportAllocs()
	for b.Loop() {
		s := New()
		s.Load(txs, obss, nodes, observers)
	}
}

func BenchmarkHashStatsAll(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeHashStats(benchAll)
	}
}

func BenchmarkHashStats24h(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeHashStats(bench24h())
	}
}

func BenchmarkScopeStats24h(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeScopeStats(bench24h())
	}
}

func BenchmarkDistanceStatsAll(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeDistanceStatsLocked(benchAll)
	}
}

func BenchmarkActivity24h(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeActivityBuckets(24, benchAll)
	}
}

func BenchmarkRetransmitCountsAll(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeRetransmitCounts(benchAll)
	}
}

func BenchmarkChannelAnalyticsAll(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeChannelAnalytics(benchAll)
	}
}

func BenchmarkPacketsByType24h(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computePacketsByType(bench24h())
	}
}

func BenchmarkGeoDistStats(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeGeoDistStats()
	}
}

func BenchmarkPacketsNewestNoFilter(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.PacketsFiltered(PacketQuery{Limit: 50, SortCol: "firstSeen", SortDesc: true})
	}
}

func BenchmarkPacketsMinObs(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.PacketsFiltered(PacketQuery{Limit: 50, MinObs: 3, SortCol: "firstSeen", SortDesc: true})
	}
}

func BenchmarkPacketsSortObsCount(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.PacketsFiltered(PacketQuery{Limit: 50, SinceMs: nowMillis() - 24*3_600_000, SortCol: "obsCount", SortDesc: true})
	}
}

func BenchmarkNodesEndpointHelpers(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.NodeRegionsAll()
		s.ObserverNodePubKeys()
	}
}

func BenchmarkIATAs(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.IATAs()
	}
}

// randHex returns a distinct hex string of n bytes, like a real packet's raw_hex.
func randHex(r *rand.Rand, n int) string {
	const digits = "0123456789abcdef"
	b := make([]byte, 2*n)
	for i := range b {
		b[i] = digits[r.IntN(16)]
	}
	return string(b)
}

func BenchmarkPacketsSearch(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.PacketsFiltered(PacketQuery{Limit: 50, Search: "needle", SortCol: "firstSeen", SortDesc: true})
	}
}

func BenchmarkTopNodesLargeLimit(b *testing.B) {
	s := benchSetup(b)
	for b.Loop() {
		s.computeTopNodes(5000, "", benchAll)
	}
}

func BenchmarkNodePacketsAll(b *testing.B) {
	s := benchSetup(b)
	pk := s.Nodes()[0].PubKey
	for b.Loop() {
		s.NodePackets(pk, 0)
	}
}
