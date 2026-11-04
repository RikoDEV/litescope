package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
)

// Wardrive sample statuses.
const (
	WardriveHeard   = "heard"   // at least one repeater confirmed hearing the ping
	WardriveDead    = "dead"    // the ping went unanswered
	WardriveClaimed = "claimed" // DEFER: the app believed the square covered (unverified)
)

// WardriveHear is one repeater that heard (or answered) a wardrive ping.
type WardriveHear struct {
	RepeaterPrefix string // upper-case hex, 2/4/6/8 chars
	SNR            *float64
	RSSI           *int
	RemoteSNR      *float64
}

// WardriveSample is one MeshMapper ping plus the repeaters that heard it.
type WardriveSample struct {
	ID         int64
	TS         int64 // Unix seconds (the ping's own timestamp)
	Lat        float64
	Lon        float64
	Type       string
	Status     string
	IATA       string
	NoiseFloor *int
	RadioFreq  string
	DeviceHash string
	ReceivedAt int64
	Hears      []WardriveHear
}

// InsertWardriveBatch stores samples and their hears in one transaction, so a
// reader never sees a sample without its hears. Duplicates (same device, type,
// timestamp and position — re-sent offline chunks) are ignored. Returns the
// number of new samples stored.
func (d *DB) InsertWardriveBatch(samples []*WardriveSample) (int, error) {
	if len(samples) == 0 {
		return 0, nil
	}
	dbtx, err := d.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer dbtx.Rollback() //nolint:errcheck

	insS, err := dbtx.Prepare(`INSERT OR IGNORE INTO wardrive_samples (ts, lat, lon, type, status, iata, noisefloor, radio_freq, device_hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, fmt.Errorf("prepare sample: %w", err)
	}
	defer insS.Close()
	insH, err := dbtx.Prepare(`INSERT INTO wardrive_hears (sample_id, repeater_prefix, snr, rssi, remote_snr) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, fmt.Errorf("prepare hear: %w", err)
	}
	defer insH.Close()

	stored := 0
	for _, s := range samples {
		res, err := insS.Exec(s.TS, s.Lat, s.Lon, s.Type, s.Status, s.IATA, s.NoiseFloor, s.RadioFreq, s.DeviceHash, s.ReceivedAt)
		if err != nil {
			return 0, fmt.Errorf("insert sample: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue // duplicate
		}
		id, err := res.LastInsertId()
		if err != nil {
			return 0, fmt.Errorf("sample id: %w", err)
		}
		s.ID = id
		stored++
		for _, h := range s.Hears {
			if _, err := insH.Exec(id, h.RepeaterPrefix, h.SNR, h.RSSI, h.RemoteSNR); err != nil {
				return 0, fmt.Errorf("insert hear: %w", err)
			}
		}
	}
	if err := dbtx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return stored, nil
}

// LoadWardriveSince returns samples with id > afterID (ascending) with their
// hears attached. A single LEFT JOIN reads one snapshot, so a sample and its
// hears (written in one transaction) always arrive together.
func (d *DB) LoadWardriveSince(afterID int64) ([]*WardriveSample, error) {
	rows, err := d.db.Query(`SELECT s.id, s.ts, s.lat, s.lon, s.type, s.status, s.iata, s.noisefloor, s.radio_freq, s.device_hash, s.received_at,
		h.repeater_prefix, h.snr, h.rssi, h.remote_snr
		FROM wardrive_samples s LEFT JOIN wardrive_hears h ON h.sample_id = s.id
		WHERE s.id > ? ORDER BY s.id ASC`, afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*WardriveSample
	var cur *WardriveSample
	for rows.Next() {
		var s WardriveSample
		var prefix sql.NullString
		var h WardriveHear
		if err := rows.Scan(&s.ID, &s.TS, &s.Lat, &s.Lon, &s.Type, &s.Status, &s.IATA, &s.NoiseFloor, &s.RadioFreq, &s.DeviceHash, &s.ReceivedAt,
			&prefix, &h.SNR, &h.RSSI, &h.RemoteSNR); err != nil {
			return nil, err
		}
		if cur == nil || cur.ID != s.ID {
			cur = &s
			out = append(out, cur)
		}
		if prefix.Valid {
			h.RepeaterPrefix = prefix.String
			cur.Hears = append(cur.Hears, h)
		}
	}
	return out, rows.Err()
}

// PruneWardriveOlderThan deletes wardrive samples (and, via cascade, their
// hears) with a ping timestamp strictly before cutoffUnix.
func (d *DB) PruneWardriveOlderThan(cutoffUnix int64) (int64, error) {
	res, err := d.db.Exec(`DELETE FROM wardrive_samples WHERE ts < ?`, cutoffUnix)
	if err != nil {
		return 0, fmt.Errorf("prune wardrive: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// WardriveSalt returns the instance's device-hash salt, generating and storing
// one on first use. Only the writer (ingestor) calls this.
func (d *DB) WardriveSalt() (string, error) {
	var salt string
	err := d.db.QueryRow(`SELECT value FROM wardrive_meta WHERE key = 'salt'`).Scan(&salt)
	if err == nil {
		return salt, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	salt = hex.EncodeToString(b)
	if _, err := d.db.Exec(`INSERT OR IGNORE INTO wardrive_meta (key, value) VALUES ('salt', ?)`, salt); err != nil {
		return "", err
	}
	// Re-read in case another writer raced us (INSERT OR IGNORE kept theirs).
	if err := d.db.QueryRow(`SELECT value FROM wardrive_meta WHERE key = 'salt'`).Scan(&salt); err != nil {
		return "", err
	}
	return salt, nil
}
