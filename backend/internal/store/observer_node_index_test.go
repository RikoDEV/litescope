package store

import (
	"strings"
	"testing"

	"github.com/litescope/backend/internal/db"
)

func floatPtr(v float64) *float64 { return &v }

// TestObserverNodeIndexResolvesExactAndAmbiguousPrefixes covers the batch
// observer→node resolver introduced to replace the old per-observer linear
// scan of every node (O(observers*nodes)). It must preserve the original
// lookup semantics: an observer ID that equals a node's pubkey resolves
// directly; a shorter ID that is a hex-prefix of a node's pubkey resolves via
// prefix match; an ambiguous prefix (multiple candidate nodes) must still
// resolve to exactly one node, deterministically, rather than whichever node
// a random map iteration turned up first; and a node without a usable
// location is never returned, matching the `usable` predicate.
func TestObserverNodeIndexResolvesExactAndAmbiguousPrefixes(t *testing.T) {
	s := New()

	nodeExact := &Node{PubKey: "EXACTID1234567890", Lat: floatPtr(1), Lon: floatPtr(2)}
	nodeAmbig1 := &Node{PubKey: "AAAA1111", Lat: floatPtr(1), Lon: floatPtr(2)}
	nodeAmbig2 := &Node{PubKey: "AAAA2222", Lat: floatPtr(1), Lon: floatPtr(2)}
	nodeUnusable := &Node{PubKey: "BBBB0000000000000000"} // no Lat/Lon

	s.nodes = map[string]*Node{
		nodeExact.PubKey:    nodeExact,
		nodeAmbig1.PubKey:   nodeAmbig1,
		nodeAmbig2.PubKey:   nodeAmbig2,
		nodeUnusable.PubKey: nodeUnusable,
	}

	got := s.observerNodeIndex([]string{
		"EXACTID1234567890",     // exact match
		"AAAA",                  // ambiguous prefix — must resolve deterministically
		"ZZZZ",                  // no match at all
		"BBBB0000000000000000", // exact ID, but the node has no usable location
	}, hasUsableLocation)

	if got["EXACTID1234567890"] != nodeExact {
		t.Fatalf("expected exact ID match to resolve to nodeExact, got %+v", got["EXACTID1234567890"])
	}
	if got["AAAA"] != nodeAmbig1 {
		t.Fatalf("expected ambiguous prefix to resolve deterministically to the lexicographically smallest pubkey (nodeAmbig1), got %+v", got["AAAA"])
	}
	if _, ok := got["ZZZZ"]; ok {
		t.Fatalf("expected no match for an unrelated prefix")
	}
	if _, ok := got["BBBB0000000000000000"]; ok {
		t.Fatalf("expected no match for a node lacking a usable location")
	}
}

// TestUpdateNodesRepairsMissingLocationViaObserverPrefixMatch is an end-to-end
// regression test for the same refactor: the node-location consensus repair
// pass (repairNodeLocationsLocked) resolves each observer to its node via
// observerNodeIndex. A target node with no advertised GPS, heard directly
// (no relay path) by exactly one located observer whose ID is only a hex
// prefix of its own pubkey, must be repaired to that observer's location.
func TestUpdateNodesRepairsMissingLocationViaObserverPrefixMatch(t *testing.T) {
	observerPubKey := "ab" + strings.Repeat("0", 62)
	targetPubKey := "cd" + strings.Repeat("0", 62)
	const observerID = "ab" // short hex prefix of observerPubKey, not equal to it

	s := New()
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "advert-target", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"` + targetPubKey + `"}`},
		},
		[]*db.ObsRow{
			// Direct observation (empty path) from the observer, so it counts
			// toward this node's location consensus.
			{ID: 1, TxID: 1, ObserverID: observerID, PathJSON: "[]", Timestamp: "2024-01-01T00:00:00Z"},
		},
		[]*db.NodeRow{
			{PubKey: observerPubKey, Name: "observer-node", Role: "repeater", Lat: floatPtr(50.0), Lon: floatPtr(19.0)},
			{PubKey: targetPubKey, Name: "target", Role: "client"}, // no advertised location
		},
		nil,
	)

	n := s.NodeByPubKey(targetPubKey)
	if n == nil {
		t.Fatalf("target node not found")
	}
	if !n.LocationApprox || n.Lat == nil || n.Lon == nil {
		t.Fatalf("expected target node's missing location to be repaired via observer consensus, got lat=%v lon=%v approx=%v", n.Lat, n.Lon, n.LocationApprox)
	}
	if *n.Lat != 50.0 || *n.Lon != 19.0 {
		t.Fatalf("expected repaired location to match the observer's raw location (50,19), got (%v,%v)", *n.Lat, *n.Lon)
	}
}
