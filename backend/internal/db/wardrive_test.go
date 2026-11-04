package db

import "testing"

func TestWardriveInsertLoadDedupePrune(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	snr := 12.25
	mk := func(ts int64) *WardriveSample {
		return &WardriveSample{TS: ts, Lat: 52.1, Lon: 21.0, Type: "TX", Status: WardriveHeard, DeviceHash: "dev", ReceivedAt: ts,
			Hears: []WardriveHear{{RepeaterPrefix: "4E", SNR: &snr}, {RepeaterPrefix: "77"}}}
	}
	n, err := d.InsertWardriveBatch([]*WardriveSample{mk(1000), mk(2000)})
	if err != nil || n != 2 {
		t.Fatalf("insert: n=%d err=%v", n, err)
	}
	// Re-sent offline chunk: identical pings are ignored.
	if n, err := d.InsertWardriveBatch([]*WardriveSample{mk(1000)}); err != nil || n != 0 {
		t.Fatalf("duplicate insert: n=%d err=%v, want 0", n, err)
	}
	// Contactless pings ('' device hash) still dedupe.
	dead := &WardriveSample{TS: 3000, Lat: 52.2, Lon: 21.1, Type: "TX", Status: WardriveDead, ReceivedAt: 3000}
	if _, err := d.InsertWardriveBatch([]*WardriveSample{dead}); err != nil {
		t.Fatal(err)
	}
	dup := *dead
	if n, _ := d.InsertWardriveBatch([]*WardriveSample{&dup}); n != 0 {
		t.Fatalf("contactless duplicate stored")
	}

	rows, err := d.LoadWardriveSince(0)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("loaded %d samples, want 3", len(rows))
	}
	if len(rows[0].Hears) != 2 || rows[0].Hears[0].SNR == nil || *rows[0].Hears[0].SNR != 12.25 {
		t.Fatalf("hears not attached: %+v", rows[0].Hears)
	}
	if len(rows[2].Hears) != 0 {
		t.Fatalf("dead sample has hears: %+v", rows[2].Hears)
	}
	since, _ := d.LoadWardriveSince(rows[0].ID)
	if len(since) != 2 {
		t.Fatalf("LoadWardriveSince(first) = %d, want 2", len(since))
	}

	if n, err := d.PruneWardriveOlderThan(2500); err != nil || n != 2 {
		t.Fatalf("prune: n=%d err=%v, want 2", n, err)
	}
	var hears int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM wardrive_hears`).Scan(&hears); err != nil {
		t.Fatal(err)
	}
	if hears != 0 {
		t.Fatalf("%d orphan hears after prune (cascade failed)", hears)
	}
}

func TestWardriveSaltStable(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	a, err := d.WardriveSalt()
	if err != nil || len(a) != 64 {
		t.Fatalf("salt=%q err=%v", a, err)
	}
	b, _ := d.WardriveSalt()
	if a != b {
		t.Fatalf("salt changed between calls")
	}
}
