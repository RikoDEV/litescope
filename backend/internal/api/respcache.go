package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// responseCache memoizes encoded JSON bodies of analytics endpoints whose
// result comes entirely from the store's analytics cache. A body is valid while
// store.CacheGeneration() is unchanged — no cached analytics value has been
// recomputed since, so re-running the handler would return the same value and
// the same bytes. That skips re-marshalling large payloads (raw RF arrays, hash
// matrices, coverage grids) on every request of every open dashboard.
type responseCache struct {
	mu      sync.Mutex
	entries map[string]respEntry
	bytes   int
}

type respEntry struct {
	gen  uint64
	at   time.Time
	body []byte
}

const (
	respCacheMaxEntries = 64
	respCacheMaxBytes   = 64 << 20 // total encoded bytes kept
	respCacheMaxBody    = 16 << 20 // larger bodies are not cached
)

func newResponseCache() *responseCache {
	return &responseCache{entries: make(map[string]respEntry)}
}

func (c *responseCache) get(key string, gen uint64) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || e.gen != gen {
		return nil, false
	}
	return e.body, true
}

func (c *responseCache) put(key string, gen uint64, body []byte) {
	if len(body) > respCacheMaxBody {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.entries[key]; ok {
		c.bytes -= len(old.body)
	}
	c.entries[key] = respEntry{gen: gen, at: time.Now(), body: body}
	c.bytes += len(body)
	for len(c.entries) > respCacheMaxEntries || c.bytes > respCacheMaxBytes {
		var oldestKey string
		var oldestAt time.Time
		for k, e := range c.entries {
			if oldestKey == "" || e.at.Before(oldestAt) {
				oldestKey, oldestAt = k, e.at
			}
		}
		c.bytes -= len(c.entries[oldestKey].body)
		delete(c.entries, oldestKey)
	}
}

// writeCachedJSON serves produce()'s value as JSON, reusing the previously
// encoded body when the store's analytics cache hasn't changed. produce must
// derive its result only from store analytics getters that go through the
// store cache (plus request parameters and static server config).
func (s *Server) writeCachedJSON(w http.ResponseWriter, r *http.Request, produce func() any) {
	key := r.URL.Path + "?" + r.URL.RawQuery
	// Read the generation before producing: if producing itself (re)computes a
	// cache entry, the generation moves past this stamp and the body is simply
	// re-encoded on the next request — never served stale.
	gen := s.Store.CacheGeneration()
	body, ok := s.resp.get(key, gen)
	if !ok {
		b, err := json.Marshal(produce())
		if err != nil {
			http.Error(w, "encode error", http.StatusInternalServerError)
			return
		}
		body = append(b, '\n') // match json.Encoder output
		s.resp.put(key, gen, body)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body) //nolint:errcheck
}
