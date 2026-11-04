package store

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
)

func ts(base time.Time, minutes int) string {
	return base.Add(time.Duration(minutes) * time.Minute).UTC().Format(time.RFC3339)
}

// TestScanStartExactWithOutOfOrderFirstSeen guards the time-window fast path:
// packets are only approximately first-seen ordered (observer timestamps can be
// backdated), so skipping the prefix via firstSeenPrefixMax must never drop an
// in-window packet that sits after older ones.
func TestScanStartExactWithOutOfOrderFirstSeen(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 9))
	base := time.Now().UTC().Add(-48 * time.Hour)
	var txs []*db.TxRow
	for i := 1; i <= 500; i++ {
		fs := ts(base, i*5-r.IntN(600)) // jitter up to 10h backwards
		if i%97 == 0 {
			fs = "garbage"
		}
		txs = append(txs, &db.TxRow{ID: int64(i), Hash: fmt.Sprintf("h%d", i), FirstSeen: fs, PayloadType: i % 4})
	}
	s := New()
	s.Load(txs, nil, nil, nil)
	for _, hours := range []int{1, 3, 12, 24, 40, 47} {
		f := NewAnalyticsFilter(hours, nil, nil, false)
		want := 0
		for _, tx := range s.packets {
			if ms := parseTimeMillis(tx.FirstSeen); ms != 0 && ms >= f.sinceMs {
				want++
			}
		}
		got := 0
		for _, c := range s.computePacketsByType(f) {
			got += c
		}
		if got != want {
			t.Fatalf("hours=%d: windowed scan counted %d packets, brute force %d", hours, got, want)
		}
	}
	// Prune rebuilds the prefix max; the invariant must hold afterwards too.
	s.Prune(base.Add(2 * time.Hour).UnixMilli())
	for i, m := range s.firstSeenPrefixMax {
		if m < s.packets[i].FirstSeenMs || (i > 0 && m < s.firstSeenPrefixMax[i-1]) {
			t.Fatalf("prefix max broken at %d after prune", i)
		}
	}
}

func bruteNodeRegions(s *Store) map[string][]string {
	out := map[string][]string{}
	for pk, txs := range s.byNode {
		seen := map[string]bool{}
		for _, tx := range txs {
			for _, o := range tx.Observations {
				if o.ObserverIATA != "" {
					seen[o.ObserverIATA] = true
				}
			}
		}
		if len(seen) > 0 {
			out[pk] = sortedKeys(seen)
		}
	}
	return out
}

func bruteIATAs(s *Store) []string {
	seen := map[string]bool{}
	for _, o := range s.observers {
		if c := normalizeIATA(o.IATA); c != "" {
			seen[c] = true
		}
	}
	for _, list := range s.byObserver {
		for _, o := range list {
			if c := normalizeIATA(o.ObserverIATA); c != "" {
				seen[c] = true
			}
		}
	}
	out := sortedKeys(seen)
	if out == nil {
		out = []string{}
	}
	return out
}

// TestIncrementalRegionIndexesMatchBruteForce covers the counters behind
// NodeRegionsAll and IATAs through Load, AddTxBatch (incl. observations for a
// packet added in an earlier batch) and Prune.
func TestIncrementalRegionIndexesMatchBruteForce(t *testing.T) {
	old := time.Now().UTC().Add(-72 * time.Hour)
	now := time.Now().UTC().Add(-time.Hour)
	txs := []*db.TxRow{
		{ID: 1, Hash: "a1", FirstSeen: ts(old, 0), PayloadType: 4, DecodedJSON: `{"pubKey":"AA"}`},
		{ID: 3, Hash: "b1", FirstSeen: ts(old, 1), PayloadType: 4, DecodedJSON: `{"pubKey":"BB"}`},
		{ID: 2, Hash: "a2", FirstSeen: ts(now, 0), PayloadType: 4, DecodedJSON: `{"pubKey":"AA"}`},
	}
	obs := []*db.ObsRow{
		{ID: 1, TxID: 1, ObserverID: "o1", ObserverIATA: "SJC", Timestamp: ts(old, 0)},
		{ID: 2, TxID: 2, ObserverID: "o2", ObserverIATA: "SFO", Timestamp: ts(now, 0)},
		{ID: 3, TxID: 3, ObserverID: "o3", ObserverIATA: "LAX", Timestamp: ts(old, 1)},
	}
	s := New()
	s.Load(txs, obs, nil, []*db.ObserverRow{{ID: "o9", IATA: "SEA"}})
	check := func(stage string) {
		t.Helper()
		if got, want := s.NodeRegionsAll(), bruteNodeRegions(s); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: NodeRegionsAll=%v want %v", stage, got, want)
		}
		if got, want := s.IATAs(), bruteIATAs(s); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: IATAs=%v want %v", stage, got, want)
		}
	}
	check("load")

	// New advert, then a later batch adds an observation to it.
	s.AddTxBatch([]*db.TxRow{{ID: 4, Hash: "c1", FirstSeen: ts(now, 2), PayloadType: 4, DecodedJSON: `{"pubKey":"CC"}`}}, nil)
	s.AddTxBatch(nil, []*db.ObsRow{
		{ID: 4, TxID: 4, ObserverID: "o4", ObserverIATA: "OAK", Timestamp: ts(now, 2)},
		{ID: 5, TxID: 2, ObserverID: "o5", ObserverIATA: "SEA", Timestamp: ts(now, 3)},
	})
	check("add")
	if n := len(s.byNode["CC"]); n != 1 {
		t.Fatalf("advert indexed %d times in byNode, want exactly once", n)
	}

	s.Prune(time.Now().UTC().Add(-24 * time.Hour).UnixMilli())
	check("prune")
	if _, ok := s.NodeRegionsAll()["BB"]; ok {
		t.Fatalf("pruned node's regions should be gone")
	}
}

// TestBestObservationRefreshedOnNewObservation: the cached BestObs must follow
// observations as they accrue across polls.
func TestBestObservationRefreshedOnNewObservation(t *testing.T) {
	s := New()
	now := time.Now().UTC()
	s.Load([]*db.TxRow{{ID: 1, Hash: "x", FirstSeen: ts(now, 0)}},
		[]*db.ObsRow{{ID: 1, TxID: 1, ObserverID: "o1", ObserverIATA: "SJC", PathJSON: `["AB"]`, Timestamp: ts(now, 0)}}, nil, nil)
	if b := s.byTxID[1].BestObservation(); b.UniqueObs != 1 || b.MaxHops != 1 {
		t.Fatalf("initial best = %+v", b)
	}
	_, updated := s.AddTxBatch(nil, []*db.ObsRow{
		{ID: 2, TxID: 1, ObserverID: "o2", ObserverIATA: "SFO", PathJSON: `["AB","CD","EF"]`, Timestamp: ts(now, 0)},
		{ID: 3, TxID: 1, ObserverID: "o2", Timestamp: ts(now, 0)},
	})
	if len(updated) != 1 {
		t.Fatalf("expected 1 updated packet, got %d", len(updated))
	}
	b := s.byTxID[1].BestObservation()
	if b.UniqueObs != 2 || b.MaxHops != 3 || b.BestObserver != "o2" || !reflect.DeepEqual(b.Regions, []string{"SFO", "SJC"}) {
		t.Fatalf("refreshed best = %+v", b)
	}
	if want := computeBestObs(s.byTxID[1].Observations); !reflect.DeepEqual(b, want) {
		t.Fatalf("cached best %+v != recomputed %+v", b, want)
	}
}

// TestStaleWhileRevalidate: past the TTL a changed version serves the old value
// immediately and refreshes it in the background.
func TestStaleWhileRevalidate(t *testing.T) {
	defer withCacheTTL(20 * time.Millisecond)()
	s := New()
	var calls atomic.Int32
	compute := func(v int) func() int { return func() int { calls.Add(1); return v } }

	if got := cachedByVersion(s, "k", 1, compute(1)); got != 1 {
		t.Fatalf("cold miss = %d", got)
	}
	time.Sleep(30 * time.Millisecond)
	if got := cachedByVersion(s, "k", 2, compute(2)); got != 1 {
		t.Fatalf("expected stale value 1 while revalidating, got %d", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := cachedByVersion(s, "k", 2, compute(3)); got == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background refresh never published")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("expected exactly 2 computations (cold + 1 refresh), got %d", n)
	}
}

func TestParseSimplePathMatchesEncodingJSON(t *testing.T) {
	s := New()
	cases := []string{
		`["AB"]`, `["AB","CD"]`, ` [ "AB" , "cd" ] `, `[]`, `[ ]`, `[""]`,
		`["A\"B"]`, `["AB"]`, `["Zażółć"]`, `[1,2]`, `["AB",]`, `["AB"`, `{"a":1}`, `["AB"] x`, `[null]`,
	}
	for _, c := range cases {
		var want []string
		wantErr := json.Unmarshal([]byte(c), &want) != nil
		got, ok := s.parseSimplePath(c)
		if !ok {
			continue // falls back to encoding/json: identical by construction
		}
		if wantErr || !reflect.DeepEqual(got, want) {
			t.Fatalf("%q: fast path %v, encoding/json %v (err=%v)", c, got, want, wantErr)
		}
	}
	if _, ok := s.parseSimplePath(`["AB","CD"]`); !ok {
		t.Fatalf("plain path should take the fast path")
	}
}

// TestGeoDistStatsMatchesHaversine: the trig-precomputed pairwise distance must
// agree with haversineKm.
func TestGeoDistStatsMatchesHaversine(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	var nodes []*db.NodeRow
	for i := range 60 {
		lat, lon := -60+r.Float64()*120, -179+r.Float64()*358
		if i < 5 { // a tight cluster exercises tiny distances
			lat, lon = 52.0+r.Float64()*1e-4, 21.0+r.Float64()*1e-4
		}
		nodes = append(nodes, &db.NodeRow{PubKey: fmt.Sprintf("%02x", i), Name: fmt.Sprintf("n%d", i), Lat: &lat, Lon: &lon})
	}
	s := New()
	s.SetLocationRepairEnabled(false)
	s.Load(nil, nil, nodes, nil)
	got := s.computeGeoDistStats()

	var maxKm, total float64
	pairs := 0
	all := s.Nodes()
	for i := range all {
		for j := i + 1; j < len(all); j++ {
			d := haversineKm(*all[i].Lat, *all[i].Lon, *all[j].Lat, *all[j].Lon)
			maxKm = math.Max(maxKm, d)
			total += d
			pairs++
		}
	}
	if got.TotalPairs != pairs || math.Abs(got.MaxDistKm-math.Round(maxKm*100)/100) > 0.011 ||
		math.Abs(got.AvgDistKm-math.Round(total/float64(pairs)*100)/100) > 0.011 {
		t.Fatalf("geo stats %+v; want pairs=%d max=%.2f avg=%.2f", got, pairs, maxKm, total/float64(pairs))
	}
}

// TestRetransmitCountsMatchesReference compares the indexed implementation
// with the straightforward per-packet set algorithm it replaced.
func TestRetransmitCountsMatchesReference(t *testing.T) {
	txs, obss, nodes, observers := smallFixture()
	s := New()
	s.Load(txs, obss, nodes, observers)

	want := map[string]int{}
	for _, tx := range s.packets {
		credited := map[string]bool{}
		for _, o := range tx.Observations {
			for _, h := range o.Path {
				if !isHexHop(h) {
					continue
				}
				for pk, n := range s.nodes {
					if participatesInRouting(n.Role) && strings.HasPrefix(strings.ToLower(pk), strings.ToLower(h)) && !credited[pk] {
						credited[pk] = true
						want[pk]++
					}
				}
			}
		}
	}
	if got := s.computeRetransmitCounts(AnalyticsFilter{}); !reflect.DeepEqual(got, want) {
		t.Fatalf("retransmit counts differ:\n got %v\nwant %v", got, want)
	}
}

// TestNodeVersionIgnoresLastSeenChurn: the periodic metadata refresh updates
// LastSeen/counters constantly; that must not invalidate node-geometry caches.
func TestNodeVersionIgnoresLastSeenChurn(t *testing.T) {
	lat, lon := 52.0, 21.0
	row := &db.NodeRow{PubKey: "abc", Name: "n", Role: "repeater", Lat: &lat, Lon: &lon, LastSeen: "2024-01-01T00:00:00Z", AdvertCount: 1}
	s := New()
	s.UpdateNodes([]*db.NodeRow{row})
	v := s.nodeVersion.Load()
	row.LastSeen, row.AdvertCount = "2024-01-02T00:00:00Z", 2
	s.UpdateNodes([]*db.NodeRow{row})
	if s.nodeVersion.Load() != v {
		t.Fatalf("LastSeen/AdvertCount change bumped nodeVersion")
	}
	if s.NodeByPubKey("abc").AdvertCount != 2 {
		t.Fatalf("node not updated")
	}
	lat2 := 53.0
	row.Lat = &lat2
	s.UpdateNodes([]*db.NodeRow{row})
	if s.nodeVersion.Load() == v {
		t.Fatalf("position change did not bump nodeVersion")
	}
}

// TestWindowedAnalyticsUnaffectedByPrefixSkip compares a handful of windowed
// analytics against the same computation over a store whose packets are
// perfectly time-sorted (so prefix skipping is trivially exact).
func TestWindowedAnalyticsUnaffectedByPrefixSkip(t *testing.T) {
	txs, obss, nodes, observers := smallFixture()
	a := New()
	a.Load(txs, obss, nodes, observers)

	sorted := slices.Clone(txs)
	sort.SliceStable(sorted, func(i, j int) bool { return parseTimeMillis(sorted[i].FirstSeen) < parseTimeMillis(sorted[j].FirstSeen) })
	b := New()
	b.Load(sorted, obss, nodes, observers)

	f := NewAnalyticsFilter(6, nil, nil, false)
	x, y := a.computeSNRByPayloadType(f), b.computeSNRByPayloadType(f)
	if len(x) != len(y) {
		t.Fatalf("snr by type differs: %v vs %v", x, y)
	}
	for k, v := range x {
		// Sums run in a different packet order, so allow float rounding noise.
		if w := y[k]; w.Count != v.Count || math.Abs(w.Avg-v.Avg) > 1e-9 {
			t.Fatalf("snr by type %s differs: %v vs %v", k, v, w)
		}
	}
	if x, y := a.computeRetransmitCounts(f), b.computeRetransmitCounts(f); !reflect.DeepEqual(x, y) {
		t.Fatalf("retransmits differ")
	}
	if x, y := a.computeOverview(f), b.computeOverview(f); x != y {
		t.Fatalf("overview differs: %+v vs %+v", x, y)
	}
}

// smallFixture is a compact, deterministic network with shuffled first-seen
// order, colliding 1-byte hops and a few non-hex legacy hops.
func smallFixture() ([]*db.TxRow, []*db.ObsRow, []*db.NodeRow, []*db.ObserverRow) {
	r := rand.New(rand.NewPCG(11, 12))
	now := time.Now().UTC()
	var nodes []*db.NodeRow
	var pks []string
	for i := range 80 {
		pk := fmt.Sprintf("%02x%062x", r.IntN(40), i) // only 40 first bytes → collisions
		pks = append(pks, pk)
		role := "repeater"
		if i%3 == 0 {
			role = "companion"
		}
		lat, lon := 37+r.Float64(), -122+r.Float64()
		nodes = append(nodes, &db.NodeRow{PubKey: pk, Name: fmt.Sprintf("n%d", i), Role: role, Lat: &lat, Lon: &lon})
	}
	observers := []*db.ObserverRow{{ID: "o1", IATA: "SJC"}, {ID: "o2", IATA: "SFO"}, {ID: "o3", IATA: "OAK"}}
	var txs []*db.TxRow
	var obss []*db.ObsRow
	var obsID int64
	for i := 1; i <= 400; i++ {
		fs := now.Add(-time.Duration(r.IntN(12*60)) * time.Minute).Format(time.RFC3339)
		txs = append(txs, &db.TxRow{ID: int64(i), Hash: fmt.Sprintf("t%d", i), FirstSeen: fs, PayloadType: r.IntN(6),
			DecodedJSON: fmt.Sprintf(`{"pubKey":%q}`, pks[r.IntN(len(pks))])})
		for range 1 + r.IntN(4) {
			obsID++
			hops := make([]string, r.IntN(4))
			for h := range hops {
				hops[h] = strings.ToUpper(pks[r.IntN(len(pks))][:2])
				if r.IntN(25) == 0 {
					hops[h] = "Legacy Name"
				}
			}
			pj, _ := json.Marshal(hops)
			snr := r.Float64() * 10
			obss = append(obss, &db.ObsRow{ID: obsID, TxID: int64(i), ObserverID: observers[r.IntN(3)].ID, ObserverIATA: "SJC",
				SNR: &snr, PathJSON: string(pj), Timestamp: fs})
		}
	}
	return txs, obss, nodes, observers
}

func TestContainsFoldMatchesToLower(t *testing.T) {
	hay := []string{"", "Needle Node", "NEEDLE", "abcNeEdLe", "Zażółć gęślą", "ZAŻÓŁĆ", "aKb", "İstanbul", "plain"}
	needles := []string{"", "needle", "node", "e n", "zażółć", "ak", "kb", "i̇stanbul", "x", "plain", "ain"}
	for _, h := range hay {
		for _, n := range needles {
			if got, want := containsFold(h, n), strings.Contains(strings.ToLower(h), n); got != want {
				t.Fatalf("containsFold(%q, %q) = %v, want %v", h, n, got, want)
			}
		}
	}
}

// TestDistanceTopPathsMatchesReference: the bounded top-10 list must hold the
// same hop counts as sorting every packet's best path.
func TestDistanceTopPathsMatchesReference(t *testing.T) {
	txs, obss, nodes, observers := smallFixture()
	s := New()
	s.Load(txs, obss, nodes, observers)
	var all []int
	for _, tx := range s.packets {
		best := -1
		for _, o := range tx.Observations {
			best = max(best, o.hexHopCount())
		}
		if best >= 2 {
			all = append(all, best)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(all)))
	all = all[:min(10, len(all))]
	var got []int
	for _, p := range s.computeDistanceStatsLocked(AnalyticsFilter{}).Top10MultiHop {
		got = append(got, p.MaxHops)
	}
	if !reflect.DeepEqual(got, all) {
		t.Fatalf("top paths %v, want %v", got, all)
	}
}

// TestRFHistogramMatchesFrontendBucketize: the server-side histogram must bin
// exactly like the frontend's bucketize() (lower-bound labels, clamped ends).
func TestRFHistogramMatchesFrontendBucketize(t *testing.T) {
	got := histogram([]float64{-30, -25, -22.6, -22.5, 0, 14.9, 15, 99}, -25, 15, 16)
	if len(got) != 16 || got[0].Label != "-25" || got[1].Label != "-23" || got[10].Label != "0" || got[15].Label != "13" {
		t.Fatalf("labels: %+v", got)
	}
	want := map[int]int{0: 3, 1: 1, 10: 1, 15: 3} // -30,-25,-22.6 → 0; -22.5 → 1; 0 → 10; 14.9,15,99 → 15
	for i, b := range got {
		if b.Count != want[i] {
			t.Fatalf("bucket %d = %d, want %d (%+v)", i, b.Count, want[i], got)
		}
	}
}

// TestRFScatterIsPairedAndBounded: scatter points come from observations that
// carry both values (the old client-side pairing mixed up two independently
// built arrays), and never exceed rfScatterPoints.
func TestRFScatterIsPairedAndBounded(t *testing.T) {
	var txs []*db.TxRow
	var obss []*db.ObsRow
	now := time.Now().UTC().Format(time.RFC3339)
	for i := 1; i <= 1000; i++ {
		txs = append(txs, &db.TxRow{ID: int64(i), Hash: fmt.Sprintf("t%d", i), FirstSeen: now})
		snr, rssi := float64(i), float64(-i)
		o := &db.ObsRow{ID: int64(i), TxID: int64(i), ObserverID: "o", Timestamp: now, SNR: &snr}
		if i%3 != 0 { // every third observation has no RSSI
			o.RSSI = &rssi
		}
		obss = append(obss, o)
	}
	s := New()
	s.Load(txs, obss, nil, nil)
	rf := s.computeGlobalRFStats(AnalyticsFilter{})
	if len(rf.Scatter) == 0 || len(rf.Scatter) > rfScatterPoints {
		t.Fatalf("scatter size %d", len(rf.Scatter))
	}
	for _, p := range rf.Scatter {
		if p.RSSI != -p.SNR || int(p.SNR)%3 == 0 {
			t.Fatalf("unpaired scatter point %+v", p)
		}
	}
}

// TestWindowWatermarksAndBoundary: with a memory window the store starts from
// the DB's max ids (not the window's), polls only newer rows, drops
// observations of transmissions older than the window, and reports a window
// boundary that stays a contiguous id suffix through Prune.
func TestWindowWatermarksAndBoundary(t *testing.T) {
	now := time.Now().UTC()
	s := New()
	s.Load([]*db.TxRow{
		{ID: 50, Hash: "w50", FirstSeen: ts(now, -120)},
		{ID: 51, Hash: "w51", FirstSeen: ts(now, -60)},
	}, []*db.ObsRow{{ID: 500, TxID: 50, ObserverID: "o", Timestamp: ts(now, -120)}}, nil, nil)
	if got := s.WindowStartTxID(); got != 50 {
		t.Fatalf("window start = %d, want 50", got)
	}
	s.RaiseWatermarks(60, 700) // DB holds newer ids than the window rows
	if tx, obs := s.LastIDs(); tx != 60 || obs != 700 {
		t.Fatalf("watermarks = %d/%d", tx, obs)
	}
	// An observation of an old transmission (id 10, below the window) is
	// dropped without blocking later ones; a new tx/obs pair is linked.
	s.AddTxBatch([]*db.TxRow{{ID: 61, Hash: "w61", FirstSeen: ts(now, 0)}},
		[]*db.ObsRow{{ID: 701, TxID: 10, ObserverID: "o", Timestamp: ts(now, 0)}, {ID: 702, TxID: 61, ObserverID: "o", Timestamp: ts(now, 0)}})
	if tx, obs := s.LastIDs(); tx != 61 || obs != 702 {
		t.Fatalf("after poll watermarks = %d/%d", tx, obs)
	}
	if p := s.PacketByHash("w61"); p == nil || len(p.Observations) != 1 {
		t.Fatalf("new packet not linked")
	}
	s.Prune(now.Add(-90 * time.Minute).UnixMilli())
	if got := s.WindowStartTxID(); got != 51 {
		t.Fatalf("window start after prune = %d, want 51", got)
	}
	empty := New()
	empty.RaiseWatermarks(99, 5)
	if got := empty.WindowStartTxID(); got != 100 {
		t.Fatalf("empty store window start = %d, want 100", got)
	}
}

func TestChannelMessagesPageReportsExhaustion(t *testing.T) {
	now := time.Now().UTC()
	var txs []*db.TxRow
	for i := 1; i <= 5; i++ {
		txs = append(txs, &db.TxRow{ID: int64(i), Hash: fmt.Sprintf("c%d", i), FirstSeen: ts(now, i), PayloadType: 5, ChannelHash: "ab", DecodedJSON: `{"type":"GRP_TXT"}`})
	}
	s := New()
	s.Load(txs, nil, nil, nil)
	out, exhausted, n := s.ChannelMessagesPage("ab", 3, 0, AnalyticsFilter{})
	if len(out) != 3 || exhausted {
		t.Fatalf("first page: %d exhausted=%v", len(out), exhausted)
	}
	out, exhausted, n = s.ChannelMessagesPage("ab", 3, 3, AnalyticsFilter{})
	if len(out) != 2 || !exhausted || n != 5 {
		t.Fatalf("second page: %d exhausted=%v matches=%d", len(out), exhausted, n)
	}
	_, exhausted, n = s.ChannelMessagesPage("ab", 3, 9, AnalyticsFilter{})
	if !exhausted || n != 5 {
		t.Fatalf("past the end: exhausted=%v matches=%d (archive offset = 9-%d)", exhausted, n, n)
	}
}
