package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/store"
)

func floatPtr(v float64) *float64 { return &v }

// TestNodesAndAnalyticsEndpointsAfterObserverIndexRefactor is an end-to-end
// HTTP-level check of the store perf refactor (batching the observer→node
// prefix lookup used by node-location repair, scope regions, map heat and
// direct links; caching NodesFiltered). It seeds a store through the exact
// same path the ingestor/server use (db rows → Store.Load, which runs the
// repair pass) and hits the real router, so a wiring mistake in any of the
// four call sites that were changed would show up as a wrong/missing field
// in the JSON response, not just in the internal store unit tests.
func TestNodesAndAnalyticsEndpointsAfterObserverIndexRefactor(t *testing.T) {
	observerPubKey := "ab" + strings.Repeat("0", 62)
	targetPubKey := "cd" + strings.Repeat("0", 62)
	const observerID = "ab" // hex prefix of observerPubKey, not equal to it

	st := store.New()
	st.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "advert-observer", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"` + observerPubKey + `"}`},
			{ID: 2, Hash: "advert-target", RawHex: "00", FirstSeen: "2024-01-01T00:00:01Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"` + targetPubKey + `"}`},
		},
		[]*db.ObsRow{
			// Direct (no relay path) observation of the target by the observer,
			// so the target's missing location gets repaired via consensus.
			{ID: 1, TxID: 2, ObserverID: observerID, ObserverIATA: "SJC", PathJSON: "[]", Timestamp: "2024-01-01T00:00:01Z"},
		},
		[]*db.NodeRow{
			{PubKey: observerPubKey, Name: "observer-node", Role: "repeater", Lat: floatPtr(50.0), Lon: floatPtr(19.0), LastSeen: "2020-01-01T00:00:00Z"},
			{PubKey: targetPubKey, Name: "target-node", Role: "client", LastSeen: "2020-01-01T00:00:00Z"}, // no advertised location
		},
		[]*db.ObserverRow{
			{ID: observerID, Name: "observer-node", IATA: "SJC"},
		},
	)

	srv := NewServer(st, NewHub(nil), map[string]string{}, []string{"*"})
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	get := func(path string) []byte {
		t.Helper()
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: status %d", path, resp.StatusCode)
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("read body of GET %s: %v", path, err)
		}
		return body
	}

	// /api/nodes: unfiltered should show the target's repaired, approximate
	// location (routed through the repair pass, not NodesFiltered's cache).
	var nodesResp struct {
		Total int `json:"total"`
		Nodes []struct {
			PubKey         string   `json:"pubKey"`
			Lat            *float64 `json:"lat"`
			Lon            *float64 `json:"lon"`
			LocationApprox bool     `json:"locationApprox"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(get("/api/nodes"), &nodesResp); err != nil {
		t.Fatalf("decode /api/nodes: %v", err)
	}
	if nodesResp.Total != 2 {
		t.Fatalf("expected 2 nodes, got %d", nodesResp.Total)
	}
	var foundTarget bool
	for _, n := range nodesResp.Nodes {
		if n.PubKey != targetPubKey {
			continue
		}
		foundTarget = true
		if !n.LocationApprox || n.Lat == nil || n.Lon == nil || *n.Lat != 50.0 || *n.Lon != 19.0 {
			t.Fatalf("expected target node repaired to observer's location (50,19), got lat=%v lon=%v approx=%v", n.Lat, n.Lon, n.LocationApprox)
		}
	}
	if !foundTarget {
		t.Fatalf("target node missing from /api/nodes response")
	}

	// /api/nodes?status=stale exercises the cached NodesFiltered path (fix #3).
	var staleResp struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal(get("/api/nodes?status=stale"), &staleResp); err != nil {
		t.Fatalf("decode /api/nodes?status=stale: %v", err)
	}
	if staleResp.Total != 2 {
		t.Fatalf("expected both nodes to be stale (never seen), got %d", staleResp.Total)
	}

	// /api/analytics/scope-regions and /api/analytics/map-heat exercise the
	// batched observer→node resolver (fix #1/#2) via computeScopeRegions and
	// computeMapHeat.
	var regions []struct {
		Region string `json:"region"`
	}
	if err := json.Unmarshal(get("/api/analytics/scope-regions"), &regions); err != nil {
		t.Fatalf("decode /api/analytics/scope-regions: %v", err)
	}
	if len(regions) != 1 || regions[0].Region != "SJC" {
		t.Fatalf("expected scope regions to attribute the observation to SJC via the observer's node, got %+v", regions)
	}

	if body := get("/api/analytics/map-heat"); len(body) == 0 {
		t.Fatalf("empty /api/analytics/map-heat response")
	}

	if body := get("/api/analytics/direct-links"); len(body) == 0 {
		t.Fatalf("empty /api/analytics/direct-links response")
	}
}
