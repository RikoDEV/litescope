package db

import (
	"fmt"
	"testing"
)

// archiveFixture: 10 packets h1..h10 in insert (id) order; h1..h6 are "old"
// (first_seen in January), h7..h10 recent — except h8, a straggler stamped old
// (observer clock / backdated rx time) but inserted after the recent ones began.
// (Ids are not 1..10: the ignored duplicate insert of h5 consumes one.)
func archiveFixture(t *testing.T) *DB {
	t.Helper()
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	var items []*WriteItem
	for i := 1; i <= 10; i++ {
		fs := "2026-01-01T00:00:00Z"
		if i >= 7 && i != 8 {
			fs = "2026-03-01T00:00:00Z"
		}
		pt, ch, dec := 2, "", fmt.Sprintf(`{"type":"TXT_MSG","text":"hello %d"}`, i)
		if i%2 == 0 {
			pt, ch, dec = 5, "ab", fmt.Sprintf(`{"type":"GRP_TXT","decryptionStatus":"decrypted","sender":"Bob%d","text":"msg"}`, i)
		}
		iata := "WAW"
		if i%3 == 0 {
			iata = "KRK"
		}
		items = append(items, &WriteItem{
			Tx:  &TxRow{RawHex: "00", Hash: fmt.Sprintf("h%d", i), FirstSeen: fs, PayloadType: pt, DecodedJSON: dec, ChannelHash: ch},
			Obs: &ObsRow{ObserverID: "o1", ObserverIATA: iata, PathJSON: "[]", Timestamp: fs},
		})
		if i == 5 { // a second observer elsewhere → obs count 2, mixed regions
			items = append(items, &WriteItem{
				Tx:  &TxRow{RawHex: "00", Hash: "h5", FirstSeen: fs, PayloadType: pt, DecodedJSON: dec},
				Obs: &ObsRow{ObserverID: "o2", ObserverIATA: "GDN", PathJSON: "[]", Timestamp: fs},
			})
		}
	}
	if err := d.WriteBatch(items); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestLoadWindowIsContiguousIDSuffix(t *testing.T) {
	d := archiveFixture(t)
	h7, _, _ := d.PacketByHash("h7")
	txs, obss, _, _, first, err := d.LoadWindow("2026-02-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	// The window starts at the first recent packet (h7) and includes the
	// backdated straggler h8, so memory is exactly h7..h10.
	if first != h7.ID || len(txs) != 4 || txs[0].Hash != "h7" || txs[3].Hash != "h10" || len(obss) != 4 {
		t.Fatalf("window first=%d txs=%d obs=%d", first, len(txs), len(obss))
	}
	maxTx, _, _ := d.MaxIDs()
	_, _, _, _, first, _ = d.LoadWindow("2027-01-01T00:00:00Z")
	if first != maxTx+1 {
		t.Fatalf("empty window should start past the last id, got %d", first)
	}
}

func TestOlderPacketsFilters(t *testing.T) {
	d := archiveFixture(t)
	h7, _, _ := d.PacketByHash("h7")
	boundary := h7.ID
	ids := func(q ArchiveQuery, limit, offset int) []string {
		t.Helper()
		rows, obs, err := d.OlderPackets(q, boundary, limit, offset)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, r := range rows {
			if len(obs[r.ID]) == 0 {
				t.Fatalf("packet %d returned without observations", r.ID)
			}
			out = append(out, r.Hash)
		}
		n, err := d.CountOlderPackets(q, boundary)
		if err != nil || (offset == 0 && limit >= n && n != len(out)) {
			t.Fatalf("count %d (err %v) vs rows %d", n, err, len(out))
		}
		return out
	}
	eq := func(name string, got, want []string) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("%s: got %v want %v", name, got, want)
		}
	}
	eq("all newest-first", ids(ArchiveQuery{}, 10, 0), []string{"h6", "h5", "h4", "h3", "h2", "h1"})
	eq("paged", ids(ArchiveQuery{}, 2, 2), []string{"h4", "h3"})
	eq("types", ids(ArchiveQuery{PayloadTypes: []int{5}}, 10, 0), []string{"h6", "h4", "h2"})
	eq("channel", ids(ArchiveQuery{ChannelHash: "ab"}, 10, 0), []string{"h6", "h4", "h2"})
	eq("minObs", ids(ArchiveQuery{MinObs: 2}, 10, 0), []string{"h5"})
	eq("region any", ids(ArchiveQuery{Regions: []string{"KRK"}}, 10, 0), []string{"h6", "h3"})
	eq("region lock", ids(ArchiveQuery{Regions: []string{"WAW"}, Lock: true}, 10, 0), []string{"h4", "h2", "h1"})
	eq("search text field", ids(ArchiveQuery{Search: "bob4"}, 10, 0), []string{"h4"})
	eq("search hash", ids(ArchiveQuery{Search: "h3"}, 10, 0), []string{"h3"})
	eq("search id digits", ids(ArchiveQuery{Search: fmt.Sprint(h7.ID - 1)}, 10, 0), []string{"h6"})
	eq("search escapes LIKE wildcards", ids(ArchiveQuery{Search: "%"}, 10, 0), nil)
	eq("since", ids(ArchiveQuery{SinceISO: "2026-02-01T00:00:00Z"}, 10, 0), nil)

	tx, obs, err := d.PacketByHash("h5")
	if err != nil || tx == nil || tx.Hash != "h5" || len(obs) != 2 {
		t.Fatalf("PacketByHash: %+v %d %v", tx, len(obs), err)
	}
	if tx, _, _ := d.PacketByHash("missing"); tx != nil {
		t.Fatalf("missing hash should return nil")
	}
}
