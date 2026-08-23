package store

import (
	"testing"

	"github.com/litescope/backend/internal/db"
)

// TestClockHealth verifies per-node skew (latest sample), drift (rate of change
// across samples) and severity bucketing, plus worst-first sort order.
func TestClockHealth(t *testing.T) {
	s := New()
	s.Load(
		[]*db.TxRow{
			// "ok": single advert, 5s skew.
			{ID: 1, Hash: "ok1", RawHex: "00", FirstSeen: "2024-01-01T00:00:05Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"okNode","timestampISO":"2024-01-01T00:00:00Z"}`},

			// "warning": two adverts a day apart, skew grows from 0s to 600s (10min) → warning + positive drift.
			{ID: 2, Hash: "warn1", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"warnNode","timestampISO":"2024-01-01T00:00:00Z"}`},
			{ID: 3, Hash: "warn2", RawHex: "00", FirstSeen: "2024-01-02T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"warnNode","timestampISO":"2024-01-01T23:50:00Z"}`},

			// "critical": single advert, 2h skew.
			{ID: 4, Hash: "crit1", RawHex: "00", FirstSeen: "2024-01-01T02:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"critNode","timestampISO":"2024-01-01T00:00:00Z"}`},

			// "absurd": single advert, 40 days skew.
			{ID: 5, Hash: "abs1", RawHex: "00", FirstSeen: "2024-02-10T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"absNode","timestampISO":"2024-01-01T00:00:00Z"}`},
		},
		nil,
		[]*db.NodeRow{
			{PubKey: "okNode", Name: "OK Node", Role: "repeater"},
			{PubKey: "warnNode", Name: "Warn Node", Role: "repeater"},
			{PubKey: "critNode", Name: "Crit Node", Role: "repeater"},
			{PubKey: "absNode", Name: "Absurd Node", Role: "repeater"},
		},
		nil,
	)

	health := s.ClockHealth(AnalyticsFilter{})
	byPK := make(map[string]ClockHealthEntry, len(health))
	for _, h := range health {
		byPK[h.PubKey] = h
	}

	ok := byPK["okNode"]
	if ok.Severity != "ok" || ok.SkewSeconds != 5 || ok.Samples != 1 || ok.DriftPerDay != 0 {
		t.Fatalf("unexpected ok entry: %+v", ok)
	}
	if ok.Name != "OK Node" || ok.Role != "repeater" || ok.LastAdvert != "2024-01-01T00:00:05Z" {
		t.Fatalf("unexpected ok metadata: %+v", ok)
	}

	warn := byPK["warnNode"]
	if warn.Severity != "warning" || warn.SkewSeconds != 600 || warn.Samples != 2 {
		t.Fatalf("unexpected warning entry: %+v", warn)
	}
	if warn.DriftPerDay != 600 {
		t.Fatalf("expected drift of 600s/day (0s -> 600s over 1 day), got %v", warn.DriftPerDay)
	}

	crit := byPK["critNode"]
	if crit.Severity != "critical" || crit.SkewSeconds != 7200 {
		t.Fatalf("unexpected critical entry: %+v", crit)
	}

	abs := byPK["absNode"]
	if abs.Severity != "absurd" || abs.SkewSeconds != 40*24*3600 {
		t.Fatalf("unexpected absurd entry: %+v", abs)
	}

	// Worst (largest |skew|) sorts first.
	if len(health) != 4 || health[0].PubKey != "absNode" || health[len(health)-1].PubKey != "okNode" {
		pks := make([]string, len(health))
		for i, h := range health {
			pks[i] = h.PubKey
		}
		t.Fatalf("expected worst-first order [absNode ... okNode], got %v", pks)
	}
}

// TestClockHealthSkipsUnparsableOrMissingTimestamps guards against a node with
// no valid ADVERT timestamp sample (e.g. malformed decode) crashing or showing
// up with a bogus zero-value skew.
func TestClockHealthSkipsUnparsableOrMissingTimestamps(t *testing.T) {
	s := New()
	s.Load(
		[]*db.TxRow{
			{ID: 1, Hash: "a", RawHex: "00", FirstSeen: "2024-01-01T00:00:00Z", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"noTimestampNode"}`},
			{ID: 2, Hash: "b", RawHex: "00", FirstSeen: "not-a-timestamp", PayloadType: 4,
				DecodedJSON: `{"type":"ADVERT","pubKey":"badFirstSeenNode","timestampISO":"2024-01-01T00:00:00Z"}`},
		},
		nil,
		[]*db.NodeRow{
			{PubKey: "noTimestampNode", Name: "No TS", Role: "repeater"},
			{PubKey: "badFirstSeenNode", Name: "Bad FirstSeen", Role: "repeater"},
		},
		nil,
	)

	if got := s.ClockHealth(AnalyticsFilter{}); len(got) != 0 {
		t.Fatalf("expected no entries for nodes without a valid sample, got %+v", got)
	}
}
