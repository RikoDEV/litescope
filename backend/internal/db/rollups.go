package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// Rollups are pre-aggregated statistics kept up to date by the ingestor as it
// writes (WriteBatch) and backfilled from existing rows by migration 00005.
// They let the server answer all-time and long-window questions without
// holding the full packet history in memory, and they outlive retention
// pruning of the raw rows. See migrations/sqlite/00005_rollups.up.sql.

// SNRHistBins is the number of 4 dB SNR histogram bins over [-25, 15).
const SNRHistBins = 10

// snrBin maps an SNR value to its histogram bin (clamped into range) — must
// match the backfill expression in migration 00005.
func snrBin(snr float64) int {
	return min(SNRHistBins-1, max(0, int(math.Floor((snr+25)/4))))
}

// hourOf returns the Unix-seconds start of the UTC hour of an RFC3339
// timestamp, or false when it doesn't parse.
func hourOf(ts string) (int64, bool) {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	u := t.Unix()
	return u - ((u%3600)+3600)%3600, true
}

// rollupWriter holds the prepared rollup upserts for one WriteBatch transaction.
type rollupWriter struct {
	tx, obs, channel, nodeRegion *sql.Stmt
}

func prepareRollups(dbtx *sql.Tx) (*rollupWriter, error) {
	w := &rollupWriter{}
	var err error
	if w.tx, err = dbtx.Prepare(`INSERT INTO rollup_tx_hourly (hour, payload_type, tx_count) VALUES (?, ?, 1)
		ON CONFLICT(hour, payload_type) DO UPDATE SET tx_count = tx_count + 1`); err != nil {
		return nil, err
	}
	hist := make([]string, SNRHistBins)
	histSet := make([]string, SNRHistBins)
	for i := range hist {
		hist[i] = fmt.Sprintf("snr_h%d", i)
		histSet[i] = fmt.Sprintf("snr_h%d = snr_h%d + excluded.snr_h%d", i, i, i)
	}
	if w.obs, err = dbtx.Prepare(`INSERT INTO rollup_obs_hourly (hour, observer_id, payload_type, obs_count,
			snr_n, snr_sum, snr_min, snr_max, rssi_n, rssi_sum, rssi_min, rssi_max, ` + strings.Join(hist, ", ") + `)
		VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?` + strings.Repeat(", ?", SNRHistBins) + `)
		ON CONFLICT(hour, observer_id, payload_type) DO UPDATE SET
			obs_count = obs_count + 1,
			snr_n = snr_n + excluded.snr_n, snr_sum = snr_sum + excluded.snr_sum,
			snr_min = min(COALESCE(snr_min, excluded.snr_min), COALESCE(excluded.snr_min, snr_min)),
			snr_max = max(COALESCE(snr_max, excluded.snr_max), COALESCE(excluded.snr_max, snr_max)),
			rssi_n = rssi_n + excluded.rssi_n, rssi_sum = rssi_sum + excluded.rssi_sum,
			rssi_min = min(COALESCE(rssi_min, excluded.rssi_min), COALESCE(excluded.rssi_min, rssi_min)),
			rssi_max = max(COALESCE(rssi_max, excluded.rssi_max), COALESCE(excluded.rssi_max, rssi_max)),
			` + strings.Join(histSet, ", ")); err != nil {
		return nil, err
	}
	if w.channel, err = dbtx.Prepare(`INSERT INTO rollup_channels (channel_hash, total, decrypted, name) VALUES (?, 1, ?, ?)
		ON CONFLICT(channel_hash) DO UPDATE SET total = total + 1, decrypted = decrypted + excluded.decrypted,
			name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END`); err != nil {
		return nil, err
	}
	if w.nodeRegion, err = dbtx.Prepare(`INSERT INTO rollup_node_regions (pub_key, iata, obs_count) VALUES (?, ?, 1)
		ON CONFLICT(pub_key, iata) DO UPDATE SET obs_count = obs_count + 1`); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *rollupWriter) close() {
	for _, s := range []*sql.Stmt{w.tx, w.obs, w.channel, w.nodeRegion} {
		if s != nil {
			s.Close()
		}
	}
}

// rollupDecoded is the slice of decoded_json the rollups need.
type rollupDecoded struct {
	PubKey           string `json:"pubKey"`
	DecryptionStatus string `json:"decryptionStatus"`
	Channel          string `json:"channel"`
}

func decodeForRollup(tx *TxRow) rollupDecoded {
	var d rollupDecoded
	if tx.PayloadType == 4 || tx.PayloadType == 5 {
		json.Unmarshal([]byte(tx.DecodedJSON), &d) //nolint:errcheck // best-effort
	}
	return d
}

// newTransmission records a newly inserted transmission.
func (w *rollupWriter) newTransmission(tx *TxRow, d rollupDecoded) error {
	if hour, ok := hourOf(tx.FirstSeen); ok {
		if _, err := w.tx.Exec(hour, tx.PayloadType); err != nil {
			return fmt.Errorf("rollup tx: %w", err)
		}
	}
	if tx.PayloadType == 5 && tx.ChannelHash != "" {
		decrypted := 0
		if d.DecryptionStatus == "decrypted" {
			decrypted = 1
		}
		if _, err := w.channel.Exec(tx.ChannelHash, decrypted, d.Channel); err != nil {
			return fmt.Errorf("rollup channel: %w", err)
		}
	}
	return nil
}

// observation records one inserted observation of tx.
func (w *rollupWriter) observation(tx *TxRow, obs *ObsRow, d rollupDecoded) error {
	if hour, ok := hourOf(obs.Timestamp); ok {
		var snrN, rssiN int
		var snrSum, rssiSum float64
		var snrV, rssiV any // NULL when absent
		hist := make([]any, SNRHistBins)
		for i := range hist {
			hist[i] = 0
		}
		if obs.SNR != nil {
			snrN, snrSum, snrV = 1, *obs.SNR, *obs.SNR
			hist[snrBin(*obs.SNR)] = 1
		}
		if obs.RSSI != nil {
			rssiN, rssiSum, rssiV = 1, *obs.RSSI, *obs.RSSI
		}
		args := append([]any{hour, obs.ObserverID, tx.PayloadType, snrN, snrSum, snrV, snrV, rssiN, rssiSum, rssiV, rssiV}, hist...)
		if _, err := w.obs.Exec(args...); err != nil {
			return fmt.Errorf("rollup obs: %w", err)
		}
	}
	if tx.PayloadType == 4 && d.PubKey != "" && obs.ObserverIATA != "" {
		if _, err := w.nodeRegion.Exec(d.PubKey, obs.ObserverIATA); err != nil {
			return fmt.Errorf("rollup node region: %w", err)
		}
	}
	return nil
}

// MarkChannelDecrypted records that a stored GRP_TXT message which previously
// had no matching key now decrypts (ingestor re-decode on startup).
func (d *DB) MarkChannelDecrypted(channelHash, name string) error {
	_, err := d.db.Exec(`UPDATE rollup_channels SET decrypted = decrypted + 1,
		name = CASE WHEN ? <> '' THEN ? ELSE name END WHERE channel_hash = ?`, name, name, channelHash)
	return err
}

// ── Reads (server) ──────────────────────────────────────────────────────────

// RollupTxByType returns all-time transmission counts per payload type.
func (d *DB) RollupTxByType() (map[int]int64, error) {
	rows, err := d.db.Query(`SELECT payload_type, SUM(tx_count) FROM rollup_tx_hourly GROUP BY payload_type`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int]int64)
	for rows.Next() {
		var pt int
		var n int64
		if err := rows.Scan(&pt, &n); err != nil {
			return nil, err
		}
		out[pt] = n
	}
	return out, rows.Err()
}

// RFAgg is an aggregate over observation SNR or RSSI values.
type RFAgg struct {
	N             int64
	Sum, Min, Max float64
}

// RollupRF returns all-time observation totals and SNR/RSSI aggregates.
func (d *DB) RollupRF() (obs int64, snr, rssi RFAgg, err error) {
	var snrMin, snrMax, rssiMin, rssiMax sql.NullFloat64
	err = d.db.QueryRow(`SELECT COALESCE(SUM(obs_count),0), COALESCE(SUM(snr_n),0), COALESCE(TOTAL(snr_sum),0), MIN(snr_min), MAX(snr_max),
		COALESCE(SUM(rssi_n),0), COALESCE(TOTAL(rssi_sum),0), MIN(rssi_min), MAX(rssi_max) FROM rollup_obs_hourly`).
		Scan(&obs, &snr.N, &snr.Sum, &snrMin, &snrMax, &rssi.N, &rssi.Sum, &rssiMin, &rssiMax)
	snr.Min, snr.Max, rssi.Min, rssi.Max = snrMin.Float64, snrMax.Float64, rssiMin.Float64, rssiMax.Float64
	return
}

// ObserverRollup is one observer's aggregated activity since a given hour.
type ObserverRollup struct {
	Hourly  map[int64]int64 // hour (unix s) → observations
	ByType  map[int]int64   // payload type → observations
	SNR     RFAgg
	SNRHist [SNRHistBins]int64
}

// RollupObserver aggregates one observer's rollup rows with hour >= sinceHour.
func (d *DB) RollupObserver(observerID string, sinceHour int64) (*ObserverRollup, error) {
	hist := make([]string, SNRHistBins)
	for i := range hist {
		hist[i] = fmt.Sprintf("snr_h%d", i)
	}
	rows, err := d.db.Query(`SELECT hour, payload_type, obs_count, snr_n, snr_sum, snr_min, snr_max, `+strings.Join(hist, ", ")+`
		FROM rollup_obs_hourly WHERE observer_id = ? AND hour >= ?`, observerID, sinceHour)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &ObserverRollup{Hourly: make(map[int64]int64), ByType: make(map[int]int64)}
	first := true
	for rows.Next() {
		var hour, n, snrN int64
		var pt int
		var snrSum float64
		var snrMin, snrMax sql.NullFloat64
		var h [SNRHistBins]int64
		dest := []any{&hour, &pt, &n, &snrN, &snrSum, &snrMin, &snrMax}
		for i := range h {
			dest = append(dest, &h[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		out.Hourly[hour] += n
		out.ByType[pt] += n
		out.SNR.N += snrN
		out.SNR.Sum += snrSum
		if snrMin.Valid && (first || snrMin.Float64 < out.SNR.Min) {
			out.SNR.Min = snrMin.Float64
		}
		if snrMax.Valid && (first || snrMax.Float64 > out.SNR.Max) {
			out.SNR.Max = snrMax.Float64
		}
		if snrMin.Valid {
			first = false
		}
		for i := range h {
			out.SNRHist[i] += h[i]
		}
	}
	return out, rows.Err()
}

// ChannelRollup is one channel hash's all-time totals.
type ChannelRollup struct {
	Hash             string
	Total, Decrypted int64
	Name             string
}

// RollupChannels returns all-time GRP_TXT totals per channel hash.
func (d *DB) RollupChannels() ([]ChannelRollup, error) {
	rows, err := d.db.Query(`SELECT channel_hash, total, decrypted, name FROM rollup_channels`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChannelRollup
	for rows.Next() {
		var c ChannelRollup
		if err := rows.Scan(&c.Hash, &c.Total, &c.Decrypted, &c.Name); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RollupNodeRegions returns, per node pubkey, the observer regions (IATA) that
// have ever heard its adverts.
func (d *DB) RollupNodeRegions() (map[string][]string, error) {
	rows, err := d.db.Query(`SELECT pub_key, iata FROM rollup_node_regions ORDER BY pub_key, iata`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]string)
	for rows.Next() {
		var pk, iata string
		if err := rows.Scan(&pk, &iata); err != nil {
			return nil, err
		}
		out[pk] = append(out[pk], iata)
	}
	return out, rows.Err()
}
