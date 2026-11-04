package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/wardrive"
)

type countingStore struct{ n int }

func (c *countingStore) InsertWardriveBatch(s []*db.WardriveSample) (int, error) {
	c.n += len(s)
	return len(s), nil
}

// TestWardriveProxyForwards checks the server → ingestor hop end to end: the
// body and X-API-Key reach the ingestor handler unchanged.
func TestWardriveProxyForwards(t *testing.T) {
	st := &countingStore{}
	ingestor := httptest.NewServer(wardrive.NewHandler(st, wardrive.Options{SharedKey: "k", TrustedProxies: []string{"127.0.0.1/32", "::1/128"}}))
	defer ingestor.Close()

	p, err := wardriveProxy(ingestor.URL)
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(p)
	defer front.Close()

	body := `{"data":[{"type":"DEFER","lat":52.2,"lon":21.0,"timestamp":` + "9999999999" + `}]}`
	req, _ := http.NewRequest(http.MethodPost, front.URL+"/api/wardrive", strings.NewReader(body))
	req.Header.Set("X-API-Key", "k")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(b), `"received":1`) {
		t.Fatalf("status=%d body=%s", resp.StatusCode, b)
	}

	if _, err := wardriveProxy("not a url"); err == nil {
		t.Fatal("expected invalid URL error")
	}
}
