package db

import (
	"fmt"
	"testing"
)

// TestPruneOlderThanBatched: pruning in several small transactions must remove
// exactly the old transmissions (and their observations) and report the total,
// and load-time raw_hex omission must not affect ObservationRawHex.
func TestPruneOlderThanBatched(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	old := pruneBatchSize
	pruneBatchSize = 3
	defer func() { pruneBatchSize = old }()

	var items []*WriteItem
	add := func(i int, firstSeen string) {
		items = append(items, &WriteItem{
			Tx:  &TxRow{RawHex: fmt.Sprintf("%02x", i), Hash: fmt.Sprintf("h%d", i), FirstSeen: firstSeen, DecodedJSON: "{}"},
			Obs: &ObsRow{ObserverID: "o", PathJSON: "[]", Timestamp: firstSeen, RawHex: fmt.Sprintf("raw%d", i)},
		})
	}
	for i := range 10 {
		add(i, "2020-01-01T00:00:00Z")
	}
	for i := 10; i < 13; i++ {
		add(i, "2026-01-01T00:00:00Z")
	}
	if err := d.WriteBatch(items); err != nil {
		t.Fatalf("WriteBatch: %v", err)
	}

	n, err := d.PruneOlderThan("2025-01-01T00:00:00Z")
	if err != nil || n != 10 {
		t.Fatalf("PruneOlderThan = %d, %v; want 10, nil", n, err)
	}
	txs, obss, _, _, err := d.LoadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(txs) != 3 || len(obss) != 3 {
		t.Fatalf("after prune: %d txs, %d obs; want 3, 3", len(txs), len(obss))
	}
	for _, o := range obss {
		if o.RawHex != "" {
			t.Fatalf("LoadAll should not load observation raw_hex")
		}
		raw, err := d.ObservationRawHex(o.TxID)
		if err != nil || raw[o.ID] == "" {
			t.Fatalf("ObservationRawHex(%d) = %v, %v", o.TxID, raw, err)
		}
	}
}
