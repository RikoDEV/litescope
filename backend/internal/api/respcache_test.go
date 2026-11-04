package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/store"
)

func TestResponseCacheKeyedOnGeneration(t *testing.T) {
	c := newResponseCache()
	c.put("/a?", 1, []byte("one"))
	if b, ok := c.get("/a?", 1); !ok || string(b) != "one" {
		t.Fatalf("expected hit for same generation")
	}
	if _, ok := c.get("/a?", 2); ok {
		t.Fatalf("a newer cache generation must miss")
	}
	c.put("/big?", 1, make([]byte, respCacheMaxBody+1))
	if _, ok := c.get("/big?", 1); ok {
		t.Fatalf("oversized bodies must not be cached")
	}
	for i := range respCacheMaxEntries + 10 {
		c.put("/k"+strings.Repeat("x", i), 1, []byte("v"))
	}
	if len(c.entries) > respCacheMaxEntries {
		t.Fatalf("cache grew past %d entries: %d", respCacheMaxEntries, len(c.entries))
	}
}

// TestCachedAnalyticsEndpointReencodesAfterRecompute: a store recompute bumps
// the cache generation, so the endpoint must not keep serving the old body.
func TestCachedAnalyticsEndpointReencodesAfterRecompute(t *testing.T) {
	st := store.New()
	st.Load([]*db.TxRow{{ID: 1, Hash: "a", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4}}, nil, nil, nil)
	srv := NewServer(st, NewHub(nil), map[string]string{}, []string{"*"})
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	get := func() string {
		t.Helper()
		resp, err := http.Get(ts.URL + "/api/analytics/packets-by-type")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	first := get()
	if !strings.Contains(first, `"ADVERT":1`) {
		t.Fatalf("unexpected body %q", first)
	}
	if again := get(); again != first {
		t.Fatalf("same generation should serve identical body")
	}
	gen := st.CacheGeneration()
	// Force a recompute (fresh store state, new cache key via hours filter).
	resp, err := http.Get(ts.URL + "/api/analytics/packets-by-type?hours=1")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if st.CacheGeneration() == gen {
		t.Fatalf("expected cache generation to advance after a recompute")
	}
	if _, ok := srv.resp.get("/api/analytics/packets-by-type?", st.CacheGeneration()); ok {
		t.Fatalf("stale body must not validate against the new generation")
	}
}
