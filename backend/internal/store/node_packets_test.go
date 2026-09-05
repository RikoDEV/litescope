package store

import (
	"testing"

	"github.com/litescope/backend/internal/db"
)

// TestNodePacketsSrcHash covers issue #56: a node's non-ADVERT traffic (which
// carries no full pubKey, only a 1-byte payload.srcHash) must still surface in
// NodePackets — otherwise a busy node's activity chart shows only its
// infrequent ADVERT and looks near-idle.
func TestNodePacketsSrcHash(t *testing.T) {
	const pubKey = "ab" + "00000000000000000000000000000000000000000000000000000000000"

	s := New()
	s.Load(
		[]*db.TxRow{
			// This node's own advert — the only packet indexed today without the fix.
			{ID: 1, Hash: "advert1", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"` + pubKey + `"}`},

			// A text message this node originated: no pubKey field, only a 1-byte
			// srcHash prefix of its pubkey ("ab").
			{ID: 2, Hash: "txt1", RawHex: "00", FirstSeen: "2024-01-01T00:05:00Z", PayloadType: 2,
				DecodedJSON: `{"type":"TXT_MSG","destHash":"cd","srcHash":"ab"}`},

			// Another node's packet with an unrelated srcHash — must not match.
			{ID: 3, Hash: "txt2", RawHex: "00", FirstSeen: "2024-01-01T00:10:00Z", PayloadType: 2,
				DecodedJSON: `{"type":"TXT_MSG","destHash":"cd","srcHash":"ff"}`},
		},
		nil,
		[]*db.NodeRow{{PubKey: pubKey, Name: "Test Node", Role: "repeater"}},
		nil,
	)

	got := s.NodePackets(pubKey, 0)
	if len(got) != 2 {
		t.Fatalf("expected 2 packets (advert + srcHash-matched TXT_MSG), got %d: %+v", len(got), got)
	}
	ids := map[int64]bool{}
	for _, tx := range got {
		ids[tx.ID] = true
	}
	if !ids[1] || !ids[2] {
		t.Fatalf("expected tx IDs 1 and 2, got %v", ids)
	}
	if ids[3] {
		t.Fatalf("packet with unrelated srcHash must not be attributed to node")
	}
}
