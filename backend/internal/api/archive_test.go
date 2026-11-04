package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/store"
)

// windowServer builds a DB with 30 old packets (40 days ago) and 10 recent
// ones (1 hour ago), every other one a channel message, then starts a server
// the way cmd/server does with a 7-day memory window.
func windowServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	d, err := db.OpenAndMigrate(filepath.ToSlash(filepath.Join(t.TempDir(), "w.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	old := time.Now().UTC().Add(-40 * 24 * time.Hour).Format(time.RFC3339)
	recent := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	var items []*db.WriteItem
	for i := 1; i <= 40; i++ {
		fs := old
		if i > 30 {
			fs = recent
		}
		pt, ch, dec := 2, "", `{"type":"TXT_MSG"}`
		if i%2 == 0 {
			pt, ch, dec = 5, "cc", `{"type":"GRP_TXT","decryptionStatus":"decrypted","channel":"Mesh","text":"hi"}`
		}
		snr := float64(i % 10)
		items = append(items, &db.WriteItem{
			Tx:  &db.TxRow{RawHex: "00", Hash: fmt.Sprintf("p%02d", i), FirstSeen: fs, PayloadType: pt, DecodedJSON: dec, ChannelHash: ch},
			Obs: &db.ObsRow{ObserverID: "obs1", ObserverIATA: "WAW", PathJSON: "[]", Timestamp: fs, SNR: &snr, RSSI: new(-90.0)},
		})
	}
	if err := d.WriteBatch(items); err != nil {
		t.Fatal(err)
	}

	window := 7 * 24 * time.Hour
	txs, obss, nodes, observers, _, err := d.LoadWindow(time.Now().UTC().Add(-window).Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	st := store.New()
	st.Load(txs, obss, nodes, observers)
	maxTx, maxObs, _ := d.MaxIDs()
	st.RaiseWatermarks(maxTx, maxObs)
	srv := NewServer(st, NewHub(nil), map[string]string{}, []string{"*"})
	srv.Archive = NewArchive(d, window)
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return ts, st
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func TestMemoryWindowServesOlderDataFromSQLite(t *testing.T) {
	ts, st := windowServer(t)
	if n, _ := st.Packets(1000, 0); len(n) != 10 {
		t.Fatalf("store should hold only the 10 recent packets, has %d", len(n))
	}

	// Packet list: totals include the archive; paging continues seamlessly.
	type page struct {
		Total   int `json:"total"`
		Packets []struct {
			Hash string `json:"hash"`
		} `json:"packets"`
	}
	var p1, p2 page
	getJSON(t, ts.URL+"/api/packets?limit=15&offset=0", &p1)
	getJSON(t, ts.URL+"/api/packets?limit=15&offset=15", &p2)
	if p1.Total != 40 || len(p1.Packets) != 15 || p1.Packets[0].Hash != "p40" || p1.Packets[9].Hash != "p31" || p1.Packets[10].Hash != "p30" {
		t.Fatalf("page 1: total=%d first=%v", p1.Total, p1.Packets)
	}
	if len(p2.Packets) != 15 || p2.Packets[0].Hash != "p25" || p2.Packets[14].Hash != "p11" {
		t.Fatalf("page 2: %v", p2.Packets)
	}
	var typed page
	getJSON(t, ts.URL+"/api/packets?limit=100&types=5", &typed)
	if typed.Total != 20 || len(typed.Packets) != 20 {
		t.Fatalf("type filter across window: total=%d len=%d", typed.Total, len(typed.Packets))
	}

	// Packet detail for a packet that only exists in SQLite.
	var detail struct {
		Hash         string `json:"hash"`
		ObsCount     int    `json:"obsCount"`
		Observations []any  `json:"observations"`
	}
	getJSON(t, ts.URL+"/api/packets/p03", &detail)
	if detail.Hash != "p03" || detail.ObsCount != 1 || len(detail.Observations) != 1 {
		t.Fatalf("archived packet detail = %+v", detail)
	}

	// Channel history pages past the window.
	var msgs []struct {
		Hash string `json:"hash"`
	}
	getJSON(t, ts.URL+"/api/channels/cc/messages?limit=8&offset=0", &msgs)
	if len(msgs) != 8 || msgs[0].Hash != "p40" || msgs[4].Hash != "p32" || msgs[5].Hash != "p30" || msgs[7].Hash != "p26" {
		t.Fatalf("channel messages across window: %v", msgs)
	}

	// All-time numbers from the rollups.
	var ov store.OverviewStats
	getJSON(t, ts.URL+"/api/analytics/overview", &ov)
	if ov.TotalPackets != 40 {
		t.Fatalf("overview total = %d, want 40", ov.TotalPackets)
	}
	var byType map[string]int
	getJSON(t, ts.URL+"/api/analytics/packets-by-type", &byType)
	if byType["GRP_TXT"] != 20 || byType["TXT_MSG"] != 20 {
		t.Fatalf("packets by type = %v", byType)
	}
	var rf store.GlobalRF
	getJSON(t, ts.URL+"/api/analytics/rf?summary=1", &rf)
	if rf.TotalObservations != 40 || rf.SNRSummary.Max != 9 || rf.RSSISummary.Avg != -90 {
		t.Fatalf("rf summary = %+v", rf)
	}
	var chans []store.ChannelSummary
	getJSON(t, ts.URL+"/api/channels", &chans)
	if len(chans) != 1 || chans[0].MessageCount != 20 || chans[0].Name != "Mesh" {
		t.Fatalf("channels = %+v", chans)
	}
	// 7-day window filters are served from memory only.
	var recentType map[string]int
	getJSON(t, ts.URL+"/api/analytics/packets-by-type?hours=168", &recentType)
	if recentType["GRP_TXT"] != 5 {
		t.Fatalf("7-day packets by type = %v", recentType)
	}

	// 30-day observer analytics from the rollup vs 7-day from memory.
	var oa30, oa7 store.ObserverAnalyticsData
	getJSON(t, ts.URL+"/api/observers/obs1/analytics?days=30", &oa30)
	getJSON(t, ts.URL+"/api/observers/obs1/analytics?days=7", &oa7)
	sum := func(d store.ObserverAnalyticsData) (n int) {
		for _, b := range d.Timeline {
			n += b.Count
		}
		return
	}
	if sum(oa7) != 10 || len(oa30.Timeline) != 30*24 || sum(oa30) != 10 || len(oa30.SNRHistogram) != db.SNRHistBins {
		t.Fatalf("observer analytics: 7d=%d 30d=%d (buckets %d, hist %d)", sum(oa7), sum(oa30), len(oa30.Timeline), len(oa30.SNRHistogram))
	}
}
