package db

import "testing"

func f64(v float64) *float64 { return &v }

// TestWriteBatchExplicitZeroLocationClearsPriorAdvert covers litescope#87:
// MeshCore nodes advertise lat=0,lon=0 to explicitly erase a previously
// published location (e.g. a decommissioned repeater). The decoder only
// populates NodeRow.Lat/Lon when the advert's HasLocation flag is set, so a
// non-nil (0,0) here is a real, intentional value — distinct from a nil
// Lat/Lon (no location field in the advert at all), which must still leave
// the stored location untouched. WriteBatch must persist the explicit (0,0)
// rather than silently keeping the previous coordinates.
func TestWriteBatchExplicitZeroLocationClearsPriorAdvert(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	const pk = "aabbcc"
	if err := d.WriteBatch([]*WriteItem{
		{Node: &NodeRow{PubKey: pk, Name: "repeater", Role: "repeater", Lat: f64(50.0), Lon: f64(19.0), LastSeen: "2026-01-01T00:00:00Z"}},
	}); err != nil {
		t.Fatalf("write initial advert: %v", err)
	}

	var lat, lon *float64
	if err := d.db.QueryRow(`SELECT lat, lon FROM nodes WHERE pub_key = ?`, pk).Scan(&lat, &lon); err != nil {
		t.Fatalf("query after initial advert: %v", err)
	}
	if lat == nil || lon == nil || *lat != 50.0 || *lon != 19.0 {
		t.Fatalf("initial advert not stored: lat=%v lon=%v", lat, lon)
	}

	// Explicit erase advert: HasLocation set, coordinates literally (0,0).
	if err := d.WriteBatch([]*WriteItem{
		{Node: &NodeRow{PubKey: pk, Name: "repeater", Role: "repeater", Lat: f64(0), Lon: f64(0), LastSeen: "2026-01-02T00:00:00Z"}},
	}); err != nil {
		t.Fatalf("write erase advert: %v", err)
	}

	if err := d.db.QueryRow(`SELECT lat, lon FROM nodes WHERE pub_key = ?`, pk).Scan(&lat, &lon); err != nil {
		t.Fatalf("query after erase advert: %v", err)
	}
	if lat == nil || lon == nil || *lat != 0 || *lon != 0 {
		t.Fatalf("erase advert was ignored, old location kept: lat=%v lon=%v", lat, lon)
	}
}

// TestWriteBatchNilLocationPreservesPriorAdvert is the companion case: an
// advert with no location field at all (decoder leaves Lat/Lon nil) must not
// clobber a previously stored, real location.
func TestWriteBatchNilLocationPreservesPriorAdvert(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	const pk = "ddeeff"
	if err := d.WriteBatch([]*WriteItem{
		{Node: &NodeRow{PubKey: pk, Name: "node", Role: "client", Lat: f64(50.0), Lon: f64(19.0), LastSeen: "2026-01-01T00:00:00Z"}},
	}); err != nil {
		t.Fatalf("write initial advert: %v", err)
	}
	if err := d.WriteBatch([]*WriteItem{
		{Node: &NodeRow{PubKey: pk, Name: "node", Role: "client", LastSeen: "2026-01-02T00:00:00Z"}},
	}); err != nil {
		t.Fatalf("write no-location advert: %v", err)
	}

	var lat, lon *float64
	if err := d.db.QueryRow(`SELECT lat, lon FROM nodes WHERE pub_key = ?`, pk).Scan(&lat, &lon); err != nil {
		t.Fatalf("query after no-location advert: %v", err)
	}
	if lat == nil || lon == nil || *lat != 50.0 || *lon != 19.0 {
		t.Fatalf("no-location advert should preserve prior GPS, got lat=%v lon=%v", lat, lon)
	}
}
