package store

import (
	"testing"

	"github.com/litescope/backend/internal/db"
)

// TestNodesFilteredCachedAndInvalidatedByVersion covers the memoization added
// to NodesFiltered (previously recomputed — walking every node, and with an
// iata filter every observation of every node's adverts — on every call).
// With the cache TTL forced to 0, a store mutation must still be reflected
// immediately, since a version mismatch always forces a recompute regardless
// of TTL.
func TestNodesFilteredCachedAndInvalidatedByVersion(t *testing.T) {
	defer withCacheTTL(0)()

	s := New()
	s.Load(nil, nil, []*db.NodeRow{
		{PubKey: "node1", Name: "n1", Role: "client"},
	}, nil)

	got := s.NodesFiltered("", "", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 node, got %d", len(got))
	}

	s.UpdateNodes([]*db.NodeRow{
		{PubKey: "node1", Name: "n1", Role: "client"},
		{PubKey: "node2", Name: "n2", Role: "client"},
	})

	got = s.NodesFiltered("", "", "")
	if len(got) != 2 {
		t.Fatalf("expected cache to reflect the new node after a store mutation (TTL=0), got %d", len(got))
	}
}

// TestNodesFilteredServesStaleWithinTTL locks in the deliberate staleness
// trade-off documented on analyticsCacheTTL: within the TTL window, a cached
// result is reused even though the store version has since changed, so a
// mutation is not guaranteed to be visible immediately.
func TestNodesFilteredServesStaleWithinTTL(t *testing.T) {
	s := New()
	s.Load(nil, nil, []*db.NodeRow{
		{PubKey: "node1", Name: "n1", Role: "client"},
	}, nil)

	got := s.NodesFiltered("", "", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 node, got %d", len(got))
	}

	s.UpdateNodes([]*db.NodeRow{
		{PubKey: "node1", Name: "n1", Role: "client"},
		{PubKey: "node2", Name: "n2", Role: "client"},
	})

	got = s.NodesFiltered("", "", "")
	if len(got) != 1 {
		t.Fatalf("expected stale cached result (1 node) within the TTL window, got %d", len(got))
	}
}

// TestNodesFilteredCacheKeyDiffersByParams ensures distinct filter
// combinations don't collide on the same cache entry.
func TestNodesFilteredCacheKeyDiffersByParams(t *testing.T) {
	defer withCacheTTL(0)()

	s := New()
	s.Load(nil, nil, []*db.NodeRow{
		{PubKey: "node1", Name: "n1", Role: "client", LastSeen: "2024-01-01T00:00:00Z"},
	}, nil)

	all := s.NodesFiltered("", "", "")
	stale := s.NodesFiltered("", "stale", "")
	active := s.NodesFiltered("", "active", "")

	if len(all) != 1 {
		t.Fatalf("expected 1 unfiltered node, got %d", len(all))
	}
	if len(stale) != 1 {
		t.Fatalf("expected the long-silent node to match status=stale, got %d", len(stale))
	}
	if len(active) != 0 {
		t.Fatalf("expected status=active to exclude the long-silent node, got %d", len(active))
	}
}
