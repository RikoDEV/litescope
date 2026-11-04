package wardrive

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/litescope/backend/internal/db"
)

type fakeStore struct{ got []*db.WardriveSample }

func (f *fakeStore) InsertWardriveBatch(s []*db.WardriveSample) (int, error) {
	f.got = append(f.got, s...)
	return len(s), nil
}

var testNow = time.Unix(1_768_762_900, 0)

func newTestHandler(st Store, key string) *Handler {
	return NewHandler(st, Options{
		SharedKey: key, MaxPingAge: 72 * time.Hour, Salt: "salt",
		TrustedProxies: []string{"10.0.0.0/8"},
		Now:            func() time.Time { return testNow },
	})
}

func post(h http.Handler, body, key, remote string, hdr ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/wardrive", strings.NewReader(body))
	r.RemoteAddr = remote
	if key != "" {
		r.Header.Set("X-API-Key", key)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHandlerMixedBatch(t *testing.T) {
	st := &fakeStore{}
	h := newTestHandler(st, "")
	ts := strconv.FormatInt(testNow.Unix()-60, 10)
	body := `{"data":[
	 {"type":"TX","lat":45.26974,"lon":-75.77746,"noisefloor":-103,"heard_repeats":"4e(12.25),77(8.50),ABCDEF(null)","timestamp":` + ts + `,"contact":"D873B1F2","iata":"yow"},
	 {"type":"TX","lat":45.27,"lon":-75.78,"heard_repeats":"None","timestamp":` + ts + `},
	 {"type":"RX","lat":45.27,"lon":-75.78,"heard_repeats":"4E(3.00)","timestamp":` + ts + `},
	 {"type":"DISC","lat":45.27,"lon":-75.78,"repeater_id":"4E","local_snr":9.5,"local_rssi":-90,"remote_snr":7,"timestamp":` + ts + `},
	 {"type":"DISC","lat":45.27,"lon":-75.78,"repeater_id":"None","timestamp":` + ts + `},
	 {"type":"TRACE","lat":45.27,"lon":-75.78,"repeater_id":"77","local_snr":null,"local_rssi":0,"timestamp":` + ts + `},
	 {"type":"DEFER","lat":45.27,"lon":-75.78,"held":"tx","timestamp":` + ts + `},
	 {"type":"SCOPES","lat":45.27,"lon":-75.78,"scopes":["*"],"timestamp":` + ts + `},
	 {"type":"FUTURE","lat":45.27,"lon":-75.78,"timestamp":` + ts + `},
	 {"type":"TX","lat":0,"lon":0,"heard_repeats":"4E(1)","timestamp":` + ts + `},
	 {"type":"TX","lat":95,"lon":0,"heard_repeats":"4E(1)","timestamp":` + ts + `},
	 {"type":"TX","lat":45,"lon":-75,"heard_repeats":"4E(1)","timestamp":1000},
	 "garbage"
	]}`
	w := post(h, body, "anything", "1.2.3.4:5555")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(st.got) != 7 {
		t.Fatalf("stored %d samples, want 7", len(st.got))
	}
	tx := st.got[0]
	if tx.Status != db.WardriveHeard || len(tx.Hears) != 3 || tx.Hears[0].RepeaterPrefix != "4E" || tx.Hears[2].SNR != nil {
		t.Fatalf("TX parse: %+v hears=%+v", tx, tx.Hears)
	}
	if tx.IATA != "YOW" || tx.NoiseFloor == nil || *tx.NoiseFloor != -103 {
		t.Fatalf("TX meta: iata=%q nf=%v", tx.IATA, tx.NoiseFloor)
	}
	if tx.DeviceHash == "" || strings.Contains(tx.DeviceHash, "D873") {
		t.Fatalf("device hash not pseudonymised: %q", tx.DeviceHash)
	}
	if st.got[1].Status != db.WardriveDead || st.got[1].DeviceHash != "" {
		t.Fatalf("TX None: %+v", st.got[1])
	}
	disc := st.got[3]
	if disc.Status != db.WardriveHeard || disc.Hears[0].RSSI == nil || *disc.Hears[0].RSSI != -90 {
		t.Fatalf("DISC: %+v", disc.Hears)
	}
	if st.got[4].Status != db.WardriveDead {
		t.Fatalf("failed DISC should be dead")
	}
	if trace := st.got[5]; trace.Hears[0].RSSI != nil {
		t.Fatalf("TRACE rssi 0 should be nil (unreadable)")
	}
	if st.got[6].Status != db.WardriveClaimed {
		t.Fatalf("DEFER should be claimed")
	}
}

func TestHandlerSharedKey(t *testing.T) {
	h := newTestHandler(&fakeStore{}, "secret")
	if w := post(h, `{"data":[]}`, "wrong", "1.2.3.4:1"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", w.Code)
	}
	if w := post(h, `{"data":[]}`, "", "1.2.3.4:1"); w.Code != http.StatusUnauthorized {
		t.Fatalf("missing key: %d", w.Code)
	}
	if w := post(h, `{"data":[]}`, "secret", "1.2.3.4:1"); w.Code != http.StatusOK {
		t.Fatalf("right key: %d", w.Code)
	}
}

func TestHandlerLimits(t *testing.T) {
	h := newTestHandler(&fakeStore{}, "")
	items := strings.Repeat(`{"type":"X"},`, 51)
	if w := post(h, `{"data":[`+strings.TrimSuffix(items, ",")+`]}`, "", "1.2.3.4:1"); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("51 items: %d", w.Code)
	}
	if w := post(h, `{"data":"`+strings.Repeat("a", maxBodyBytes)+`"}`, "", "1.2.3.5:1"); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("huge body: %d", w.Code)
	}
	if w := post(h, `not json`, "", "1.2.3.6:1"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", w.Code)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/wardrive", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
}

func TestHandlerRateLimitPerIP(t *testing.T) {
	h := newTestHandler(&fakeStore{}, "")
	ok := 0
	for range 40 {
		if post(h, `{"data":[]}`, "", "9.9.9.9:1").Code == http.StatusOK {
			ok++
		}
	}
	if ok != int(rateBurst) {
		t.Fatalf("allowed %d requests from one IP, want burst %d", ok, int(rateBurst))
	}
	// A different client is unaffected.
	if post(h, `{"data":[]}`, "", "8.8.8.8:1").Code != http.StatusOK {
		t.Fatal("second IP was limited")
	}
}

func TestClientIPTrustedProxy(t *testing.T) {
	h := newTestHandler(&fakeStore{}, "")
	cases := []struct {
		remote, xff, cf, want string
	}{
		{"1.2.3.4:1", "5.6.7.8", "", "1.2.3.4"},             // untrusted peer: headers ignored
		{"10.0.0.2:1", "5.6.7.8", "", "5.6.7.8"},            // trusted proxy
		{"10.0.0.2:1", "6.6.6.6, 5.6.7.8", "", "5.6.7.8"},   // spoofed left entry ignored
		{"10.0.0.2:1", "5.6.7.8, 10.0.0.9", "", "5.6.7.8"},  // skip trusted hops
		{"10.0.0.2:1", "", "7.7.7.7", "10.0.0.2"},           // CF header is spoofable: ignored
		{"10.0.0.2:1", "", "", "10.0.0.2"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if c.cf != "" {
			r.Header.Set("CF-Connecting-IP", c.cf)
		}
		if got := h.clientIP(r); got != c.want {
			t.Errorf("remote=%s xff=%q cf=%q: got %s want %s", c.remote, c.xff, c.cf, got, c.want)
		}
	}
}

func TestParseHeardRepeats(t *testing.T) {
	h, none := parseHeardRepeats("None")
	if !none || h != nil {
		t.Fatal("None")
	}
	h, _ = parseHeardRepeats("4E(12.25), 4e(1), zz(3), 123(4), AABBCCDD(-5.5)")
	if len(h) != 2 || h[0].RepeaterPrefix != "4E" || h[1].RepeaterPrefix != "AABBCCDD" || *h[1].SNR != -5.5 {
		t.Fatalf("got %+v", h)
	}
}
