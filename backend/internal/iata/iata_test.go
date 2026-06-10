package iata

import "testing"

func TestValid(t *testing.T) {
	valid := []string{"WAW", "KRK", "WMI", "SZY", "LHR", "JFK", "SIN", "AAA", "LON", "NYC", "TYO"}
	for _, c := range valid {
		if !Valid(c) {
			t.Errorf("Valid(%q) = false, want true", c)
		}
	}
	invalid := []string{"", "W", "WA", "WAWA", "ZZZ", "QQQ", "waw", "123", "A1B"}
	for _, c := range invalid {
		if Valid(c) {
			t.Errorf("Valid(%q) = true, want false", c)
		}
	}
}

// The embedded set must be sorted unique triplets of uppercase ASCII letters —
// Valid's binary search depends on it.
func TestCodesWellFormed(t *testing.T) {
	if len(codes)%3 != 0 {
		t.Fatalf("codes length %d not a multiple of 3", len(codes))
	}
	prev := ""
	for i := 0; i+3 <= len(codes); i += 3 {
		c := codes[i : i+3]
		for _, ch := range c {
			if ch < 'A' || ch > 'Z' {
				t.Fatalf("code %q contains non-uppercase char", c)
			}
		}
		if c <= prev {
			t.Fatalf("codes not strictly sorted at %q (prev %q)", c, prev)
		}
		prev = c
	}
}
