package store

import (
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
)

func covTestStore(t *testing.T) *Store {
	t.Helper()
	old := analyticsCacheTTL
	analyticsCacheTTL = 0
	t.Cleanup(func() { analyticsCacheTTL = old })
	lat, lon := 52.2297, 21.0122 // Warsaw
	farLat, farLon := 40.4168, -3.7038 // Madrid
	s := New()
	s.Load(nil, nil, []*db.NodeRow{
		{PubKey: "4e11" + "00000000000000000000000000000000000000000000000000000000000", Name: "Near", Role: "repeater", Lat: &lat, Lon: &lon},
		{PubKey: "7700" + "00000000000000000000000000000000000000000000000000000000000", Name: "Far", Role: "repeater", Lat: &farLat, Lon: &farLon},
		{PubKey: "9900" + "00000000000000000000000000000000000000000000000000000000000", Name: "NoLoc", Role: "repeater"},
		{PubKey: "aa00" + "00000000000000000000000000000000000000000000000000000000000", Name: "Phone", Role: "companion", Lat: &lat, Lon: &lon},
	}, nil)
	return s
}

func sample(id int64, ts int64, lat, lon float64, dev, status string, hears ...string) *db.WardriveSample {
	s := &db.WardriveSample{ID: id, TS: ts, Lat: lat, Lon: lon, Type: "TX", Status: status, DeviceHash: dev, IATA: "WAW"}
	for _, h := range hears {
		s.Hears = append(s.Hears, db.WardriveHear{RepeaterPrefix: h, SNR: new(float64(id))})
	}
	return s
}

func TestCoveragePlausibilityAndCells(t *testing.T) {
	s := covTestStore(t)
	now := time.Now().Unix()
	s.AddWardrive([]*db.WardriveSample{
		sample(1, now-100, 52.23, 21.01, "a", db.WardriveHeard, "4E"),       // near repeater: ok
		sample(2, now-90, 52.23, 21.01, "a", db.WardriveHeard, "77"),        // repeater in Madrid: implausible → dropped
		sample(3, now-80, 52.23, 21.01, "b", db.WardriveHeard, "99"),        // unlocated repeater: kept
		sample(4, now-70, 52.23, 21.01, "b", db.WardriveHeard, "AA"),        // companion, not a repeater → dropped
		sample(5, now-60, 52.23, 21.01, "b", db.WardriveDead),
		sample(6, now-50, 52.23, 21.01, "c", db.WardriveClaimed),
		sample(7, now-40, 52.30, 21.10, "d", db.WardriveDead),               // different cell
	})

	res := s.Coverage(AnalyticsFilter{}, CoverageOpts{})
	if res.Samples != 4 || res.Rejected != 2 {
		t.Fatalf("samples=%d rejected=%d, want 4/2", res.Samples, res.Rejected)
	}
	if len(res.Cells) != 2 {
		t.Fatalf("cells=%d, want 2: %+v", len(res.Cells), res.Cells)
	}
	c := res.Cells[0]
	if c.Heard != 2 || c.Dead != 1 || c.Claimed != 0 || c.Devices != 2 || c.Ratio != 0.667 {
		t.Fatalf("cell: %+v", c)
	}
	if c.BestSNR == nil || *c.BestSNR != 3 || len(c.TopRepeaters) != 2 {
		t.Fatalf("cell repeaters: best=%v %+v", c.BestSNR, c.TopRepeaters)
	}
	if !(c.Lat <= 52.23 && 52.23 < c.Lat+c.SizeLat && c.Lon <= 21.01 && 21.01 < c.Lon+c.SizeLon) {
		t.Fatalf("cell bounds %+v don't contain the ping", c)
	}
	if c.SizeLon <= c.SizeLat {
		t.Fatalf("cells should widen in longitude at 52°N: %+v", c)
	}

	// Unverified adds the DEFER ping.
	if u := s.Coverage(AnalyticsFilter{}, CoverageOpts{Unverified: true}); u.Cells[0].Claimed != 1 {
		t.Fatalf("unverified: %+v", u.Cells[0])
	}

	// Per-repeater view: only cells heard by 4E; other hears count as not heard.
	r := s.Coverage(AnalyticsFilter{}, CoverageOpts{Repeater: "4e11"})
	if len(r.Cells) != 1 || r.Cells[0].Heard != 1 || r.Cells[0].Dead != 2 {
		t.Fatalf("repeater filter: %+v", r.Cells)
	}

	// Fine precision yields smaller cells.
	if f := s.Coverage(AnalyticsFilter{}, CoverageOpts{Precision: "fine"}); f.CellDeg >= res.CellDeg {
		t.Fatalf("fine cellDeg %v >= coarse %v", f.CellDeg, res.CellDeg)
	}
}

func TestCoverageFiltersAndMinDevices(t *testing.T) {
	s := covTestStore(t)
	now := time.Now().Unix()
	old := sample(1, now-3*3600, 52.23, 21.01, "a", db.WardriveDead)
	other := sample(2, now-60, 52.23, 21.01, "b", db.WardriveDead)
	other.IATA = "KRK"
	s.AddWardrive([]*db.WardriveSample{old, other})

	if res := s.Coverage(NewAnalyticsFilter(1, nil, nil, false), CoverageOpts{}); res.Samples != 1 {
		t.Fatalf("hours filter: samples=%d", res.Samples)
	}
	if res := s.Coverage(NewAnalyticsFilter(0, []string{"WAW"}, nil, false), CoverageOpts{}); res.Samples != 1 {
		t.Fatalf("region filter: samples=%d", res.Samples)
	}
	if res := s.Coverage(NewAnalyticsFilter(0, nil, []string{"PL"}, false), CoverageOpts{}); res.Samples != 2 {
		t.Fatalf("country PL: samples=%d", res.Samples)
	}
	if res := s.Coverage(NewAnalyticsFilter(0, nil, []string{"DE"}, false), CoverageOpts{}); res.Samples != 0 {
		t.Fatalf("country DE: samples=%d", res.Samples)
	}

	s.SetCoverageLimits(150, 3)
	if res := s.Coverage(AnalyticsFilter{}, CoverageOpts{}); len(res.Cells) != 0 {
		t.Fatalf("minDevices=3 should hide a 2-device cell: %+v", res.Cells)
	}
	s.SetCoverageLimits(150, 2)
	if res := s.Coverage(AnalyticsFilter{}, CoverageOpts{}); len(res.Cells) != 1 {
		t.Fatalf("minDevices=2: %+v", res.Cells)
	}
}

func TestCoverageSpeedCheck(t *testing.T) {
	s := covTestStore(t)
	now := time.Now().Unix()
	s.AddWardrive([]*db.WardriveSample{
		sample(1, now-300, 52.23, 21.01, "a", db.WardriveDead),
		sample(2, now-290, 53.50, 21.01, "a", db.WardriveDead), // 140 km in 10 s → rejected
		sample(3, now-200, 52.24, 21.01, "a", db.WardriveDead), // 1 km in 100 s → fine
		sample(4, now-100, 53.50, 21.01, "",  db.WardriveDead), // no device: never speed-checked
	})
	res := s.Coverage(AnalyticsFilter{}, CoverageOpts{})
	if res.Rejected != 1 || res.Samples != 3 {
		t.Fatalf("rejected=%d samples=%d, want 1/3", res.Rejected, res.Samples)
	}
}

func TestCoverageAddPruneAndCache(t *testing.T) {
	s := covTestStore(t)
	now := time.Now().Unix()
	if n := s.AddWardrive([]*db.WardriveSample{sample(1, now-10, 52.23, 21.01, "a", db.WardriveDead)}); n != 1 {
		t.Fatalf("add=%d", n)
	}
	if s.Coverage(AnalyticsFilter{}, CoverageOpts{}).Samples != 1 {
		t.Fatal("first read")
	}
	// Re-delivered row is ignored; a new one invalidates the cache.
	s.AddWardrive([]*db.WardriveSample{sample(1, now-10, 52.23, 21.01, "a", db.WardriveDead), sample(2, now-5, 52.23, 21.01, "a", db.WardriveDead)})
	if got := s.Coverage(AnalyticsFilter{}, CoverageOpts{}).Samples; got != 2 {
		t.Fatalf("after add: %d", got)
	}
	if s.LastWardriveID() != 2 {
		t.Fatalf("lastID=%d", s.LastWardriveID())
	}
	if n := s.PruneCoverage((now - 7) * 1000); n != 1 {
		t.Fatalf("pruned %d", n)
	}
	if got := s.Coverage(AnalyticsFilter{}, CoverageOpts{}).Samples; got != 1 {
		t.Fatalf("after prune: %d", got)
	}
}

// TestCoverageConcurrent exercises the coverage lock model under -race:
// polling adds, prunes, node refreshes and reads all at once.
func TestCoverageConcurrent(t *testing.T) {
	s := covTestStore(t)
	now := time.Now().Unix()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := int64(1); i <= 300; i++ {
			s.AddWardrive([]*db.WardriveSample{sample(i, now-300+i, 52.23, 21.01, "a", db.WardriveHeard, "4E")})
			if i%50 == 0 {
				s.PruneCoverage((now - 300 + i - 20) * 1000)
				s.UpdateNodes(nil)
			}
		}
	}()
	for {
		select {
		case <-done:
			return
		default:
			s.Coverage(AnalyticsFilter{}, CoverageOpts{Precision: "fine"})
			s.Coverage(NewAnalyticsFilter(1, []string{"WAW"}, nil, false), CoverageOpts{Repeater: "4E"})
		}
	}
}
