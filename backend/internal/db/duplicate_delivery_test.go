package db

import "testing"

// TestWriteBatchDuplicateDeliveryDoesNotInflateObserverPacketCount covers the
// case where the same physical observer's packet reaches the ingestor twice
// (e.g. bridged through two configured mqttSources pointing at the same
// underlying MeshCore network). The transmission is deduped by content hash,
// but each delivery still writes its own observations row — packet_count
// must only be bumped once per (transmission, observer) pair, not once per
// delivery, or an observer's lifetime packet count inflates independent of
// how many distinct packets it actually relayed.
func TestWriteBatchDuplicateDeliveryDoesNotInflateObserverPacketCount(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	const observerID = "obs1"
	item := func() *WriteItem {
		return &WriteItem{
			Tx: &TxRow{
				RawHex: "aabbcc", Hash: "hash1", FirstSeen: "2026-01-01T00:00:00Z",
				RouteType: 0, PayloadType: 1, DecodedJSON: "{}",
			},
			Obs: &ObsRow{
				ObserverID: observerID, PathJSON: "[]", Timestamp: "2026-01-01T00:00:00Z",
			},
			Observer: &ObserverUpsert{ID: observerID, Now: "2026-01-01T00:00:00Z"},
		}
	}

	// First delivery (e.g. via the "local" mqttSource).
	if err := d.WriteBatch([]*WriteItem{item()}); err != nil {
		t.Fatalf("write first delivery: %v", err)
	}
	// Duplicate delivery of the exact same packet from the same observer,
	// bridged through a second mqttSource (e.g. CoreScope).
	if err := d.WriteBatch([]*WriteItem{item()}); err != nil {
		t.Fatalf("write duplicate delivery: %v", err)
	}

	var packetCount int
	if err := d.db.QueryRow(`SELECT packet_count FROM observers WHERE id = ?`, observerID).Scan(&packetCount); err != nil {
		t.Fatalf("query observer packet_count: %v", err)
	}
	if packetCount != 1 {
		t.Fatalf("packet_count should stay at 1 for a duplicated delivery, got %d", packetCount)
	}

	var obsCount int
	if err := d.db.QueryRow(`SELECT observation_count FROM transmissions WHERE hash = ?`, "hash1").Scan(&obsCount); err != nil {
		t.Fatalf("query transmission observation_count: %v", err)
	}
	if obsCount != 1 {
		t.Fatalf("observation_count should stay at 1 for a duplicated delivery, got %d", obsCount)
	}

	var rowCount int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM observations`).Scan(&rowCount); err != nil {
		t.Fatalf("query observations row count: %v", err)
	}
	if rowCount != 2 {
		t.Fatalf("both deliveries should still be stored as separate observations rows, got %d", rowCount)
	}
}

// TestWriteBatchDistinctObserversEachBumpPacketCount is the companion case: a
// packet genuinely observed by two different observers must still bump each
// observer's packet_count independently — the dedup must key on
// (transmission, observer), not just transmission.
func TestWriteBatchDistinctObserversEachBumpPacketCount(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	item := func(observerID string) *WriteItem {
		return &WriteItem{
			Tx: &TxRow{
				RawHex: "aabbcc", Hash: "hash1", FirstSeen: "2026-01-01T00:00:00Z",
				RouteType: 0, PayloadType: 1, DecodedJSON: "{}",
			},
			Obs: &ObsRow{
				ObserverID: observerID, PathJSON: "[]", Timestamp: "2026-01-01T00:00:00Z",
			},
			Observer: &ObserverUpsert{ID: observerID, Now: "2026-01-01T00:00:00Z"},
		}
	}

	if err := d.WriteBatch([]*WriteItem{item("obsA"), item("obsB")}); err != nil {
		t.Fatalf("write from two observers: %v", err)
	}

	for _, id := range []string{"obsA", "obsB"} {
		var packetCount int
		if err := d.db.QueryRow(`SELECT packet_count FROM observers WHERE id = ?`, id).Scan(&packetCount); err != nil {
			t.Fatalf("query observer %s packet_count: %v", id, err)
		}
		if packetCount != 1 {
			t.Fatalf("observer %s packet_count should be 1, got %d", id, packetCount)
		}
	}

	var obsCount int
	if err := d.db.QueryRow(`SELECT observation_count FROM transmissions WHERE hash = ?`, "hash1").Scan(&obsCount); err != nil {
		t.Fatalf("query transmission observation_count: %v", err)
	}
	if obsCount != 2 {
		t.Fatalf("observation_count should be 2 for two distinct observers, got %d", obsCount)
	}
}
