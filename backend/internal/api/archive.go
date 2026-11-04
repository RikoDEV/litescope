package api

import (
	"maps"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/store"
)

// Archive serves what the in-memory store no longer holds once a memory
// window is configured: reads that reach past the window go to SQLite, and
// all-time / long-window statistics come from the ingestor-maintained rollups.
// A nil *Archive (or Window 0) means "everything is in memory" — the store
// answers alone, exactly as before.
type Archive struct {
	DB     *db.DB
	Window time.Duration // in-memory history the server keeps; 0 = unlimited

	mu    sync.Mutex
	cache map[string]archiveEntry
}

type archiveEntry struct {
	at    time.Time
	value any
}

// archiveTTL bounds how stale a rollup/count result may be served. The
// frontend already applies live increments on top of these totals.
const archiveTTL = 30 * time.Second

func NewArchive(database *db.DB, window time.Duration) *Archive {
	return &Archive{DB: database, Window: window, cache: make(map[string]archiveEntry)}
}

func (a *Archive) enabled() bool { return a != nil && a.Window > 0 }

// covers reports whether a request for the last `hours` hours is fully served
// by the in-memory window (hours <= 0 means all time, which never is).
func (a *Archive) covers(hours int) bool {
	return hours > 0 && time.Duration(hours)*time.Hour <= a.Window
}

// cached memoizes fn under key for archiveTTL. Errors are not cached.
func archiveCached[T any](a *Archive, key string, fn func() (T, error)) (T, error) {
	a.mu.Lock()
	if e, ok := a.cache[key]; ok && time.Since(e.at) < archiveTTL {
		a.mu.Unlock()
		return e.value.(T), nil
	}
	a.mu.Unlock()
	v, err := fn()
	if err != nil {
		return v, err
	}
	a.mu.Lock()
	if len(a.cache) > 256 { // bound key growth (filtered packet counts)
		a.cache = make(map[string]archiveEntry)
	}
	a.cache[key] = archiveEntry{at: time.Now(), value: v}
	a.mu.Unlock()
	return v, nil
}

// buildTxs turns archive rows into standalone packets for the summarizers.
func buildTxs(rows []*db.TxRow, obs map[int64][]*db.ObsRow) []*store.Tx {
	out := make([]*store.Tx, 0, len(rows))
	for _, r := range rows {
		out = append(out, store.BuildTx(r, obs[r.ID]))
	}
	return out
}

func (a *Archive) totalPackets() (int, error) {
	byType, err := archiveCached(a, "txByType", a.DB.RollupTxByType)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, c := range byType {
		n += c
	}
	return int(n), nil
}

func (a *Archive) packetsByType() (map[string]int, error) {
	byType, err := archiveCached(a, "txByType", a.DB.RollupTxByType)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(byType))
	for pt, c := range byType {
		out[decoder.PayloadName(pt)] += int(c)
	}
	return out, nil
}

type rfRollup struct {
	obs       int64
	snr, rssi db.RFAgg
}

// rfSummary is the all-time /api/analytics/rf?summary=1 payload.
func (a *Archive) rfSummary() (store.GlobalRF, error) {
	r, err := archiveCached(a, "rf", func() (rfRollup, error) {
		obs, snr, rssi, err := a.DB.RollupRF()
		return rfRollup{obs, snr, rssi}, err
	})
	if err != nil {
		return store.GlobalRF{}, err
	}
	summ := func(x db.RFAgg) store.FloatSummary {
		if x.N == 0 {
			return store.FloatSummary{}
		}
		return store.FloatSummary{Avg: x.Sum / float64(x.N), Min: x.Min, Max: x.Max}
	}
	// Matches the store: totalObservations counts observations carrying RSSI.
	return store.GlobalRF{TotalObservations: int(r.rssi.N), SNRSummary: summ(r.snr), RSSISummary: summ(r.rssi)}, nil
}

// channels is the all-time channel list (same semantics as Store.Channels).
func (a *Archive) channels() ([]store.ChannelSummary, error) {
	rows, err := archiveCached(a, "channels", a.DB.RollupChannels)
	if err != nil {
		return nil, err
	}
	out := make([]store.ChannelSummary, 0, len(rows))
	for _, c := range rows {
		name := c.Name
		if name == "" {
			name = c.Hash
		}
		count := c.Total
		if c.Decrypted > 0 {
			count = c.Decrypted
		}
		out = append(out, store.ChannelSummary{Hash: c.Hash, Name: name, MessageCount: int(count)})
	}
	return out, nil
}

// nodeRegions merges the all-time node → region rollup into the in-memory map.
func (a *Archive) nodeRegions(mem map[string][]string) map[string][]string {
	persisted, err := archiveCached(a, "nodeRegions", a.DB.RollupNodeRegions)
	if err != nil || len(persisted) == 0 {
		return mem
	}
	out := make(map[string][]string, len(persisted)+len(mem))
	maps.Copy(out, persisted)
	for pk, regs := range mem {
		existing := out[pk]
		if existing == nil {
			out[pk] = regs
			continue
		}
		set := make(map[string]struct{}, len(existing)+len(regs))
		for _, r := range existing {
			set[r] = struct{}{}
		}
		for _, r := range regs {
			set[r] = struct{}{}
		}
		merged := make([]string, 0, len(set))
		for r := range set {
			merged = append(merged, r)
		}
		sort.Strings(merged)
		out[pk] = merged
	}
	return out
}

// observerAnalytics serves observer analytics for windows longer than memory.
func (a *Archive) observerAnalytics(id string, days int) (store.ObserverAnalyticsData, error) {
	start := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Truncate(time.Hour).Unix()
	key := "observer|" + id + "|" + time.Unix(start, 0).UTC().Format("2006010215") + "|" + strconv.Itoa(days)
	return archiveCached(a, key, func() (store.ObserverAnalyticsData, error) {
		r, err := a.DB.RollupObserver(id, start)
		if err != nil {
			return store.ObserverAnalyticsData{}, err
		}
		return store.ObserverAnalyticsFromRollup(days, r), nil
	})
}
