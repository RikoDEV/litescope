package db

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

type TxRow struct {
	ID           int64
	RawHex       string
	Hash         string
	FirstSeen    string
	RouteType    int
	PayloadType  int
	DecodedJSON  string
	ObsCount     int
	ChannelHash  string
}

type ObsRow struct {
	ID           int64
	TxID         int64
	ObserverID   string
	ObserverName string
	ObserverIATA string
	RSSI         *float64
	SNR          *float64
	Score        *float64
	Direction    string
	PathJSON     string
	Timestamp    string
}

type NodeRow struct {
	PubKey      string
	Name        string
	Role        string
	Lat         *float64
	Lon         *float64
	LastSeen    string
	FirstSeen   string
	AdvertCount int
	BatteryMv   *int
	TempC       *float64
}

type ObserverRow struct {
	ID         string
	Name       string
	IATA       string
	LastSeen   string
	FirstSeen  string
	PktCount   int
	Model      string
	Firmware   string
	BatteryMv  *int
	UptimeSecs *int64
	NoiseFloor *float64
}

type PacketMeta struct {
	ObserverMeta
}

type ObserverMeta struct {
	Model      *string
	Firmware   *string
	BatteryMv  *int
	UptimeSecs *int64
	NoiseFloor *float64
}

func Open(path string) (*DB, error) {
	connStr := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on", path)
	db, err := sql.Open("sqlite", connStr)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite: single writer
	d := &DB{db: db}
	if err := d.applySchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return d, nil
}

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) applySchema() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS transmissions (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			raw_hex           TEXT    NOT NULL,
			hash              TEXT    NOT NULL UNIQUE,
			first_seen        TEXT    NOT NULL,
			route_type        INTEGER,
			payload_type      INTEGER,
			decoded_json      TEXT,
			observation_count INTEGER NOT NULL DEFAULT 1,
			channel_hash      TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tx_first_seen   ON transmissions(first_seen)`,
		`CREATE INDEX IF NOT EXISTS idx_tx_payload_type ON transmissions(payload_type)`,
		`CREATE INDEX IF NOT EXISTS idx_tx_channel_hash ON transmissions(channel_hash) WHERE channel_hash IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS observations (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			tx_id         INTEGER NOT NULL REFERENCES transmissions(id),
			observer_id   TEXT    NOT NULL,
			observer_name TEXT,
			observer_iata TEXT,
			rssi          REAL,
			snr           REAL,
			score         REAL,
			direction     TEXT,
			path_json     TEXT,
			timestamp     TEXT    NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_obs_tx_id    ON observations(tx_id)`,
		`CREATE INDEX IF NOT EXISTS idx_obs_observer ON observations(observer_id)`,
		`CREATE TABLE IF NOT EXISTS nodes (
			pub_key       TEXT PRIMARY KEY,
			name          TEXT,
			role          TEXT,
			lat           REAL,
			lon           REAL,
			last_seen     TEXT,
			first_seen    TEXT,
			advert_count  INTEGER NOT NULL DEFAULT 0,
			battery_mv    INTEGER,
			temperature_c REAL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen)`,
		`CREATE TABLE IF NOT EXISTS observers (
			id           TEXT PRIMARY KEY,
			name         TEXT,
			iata         TEXT,
			last_seen    TEXT,
			first_seen   TEXT,
			packet_count INTEGER NOT NULL DEFAULT 0,
			model        TEXT,
			firmware     TEXT,
			battery_mv   INTEGER,
			uptime_secs  INTEGER,
			noise_floor  REAL
		)`,
	}
	for _, s := range stmts {
		if _, err := d.db.Exec(s); err != nil {
			return fmt.Errorf("exec %q: %w", s[:min(40, len(s))], err)
		}
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// InsertTransmission upserts a transmission and adds an observation.
// Returns the inserted transmission ID and whether it was new.
func (d *DB) InsertTransmission(tx *TxRow, obs *ObsRow) (int64, bool, error) {
	var txID int64
	var isNew bool

	// Try to insert; if hash exists, just get the ID
	res, err := d.db.Exec(
		`INSERT OR IGNORE INTO transmissions (raw_hex, hash, first_seen, route_type, payload_type, decoded_json, channel_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		tx.RawHex, tx.Hash, tx.FirstSeen, tx.RouteType, tx.PayloadType, tx.DecodedJSON, nilIfEmpty(tx.ChannelHash),
	)
	if err != nil {
		return 0, false, fmt.Errorf("insert tx: %w", err)
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		txID, _ = res.LastInsertId()
		isNew = true
	} else {
		err = d.db.QueryRow(`SELECT id FROM transmissions WHERE hash = ?`, tx.Hash).Scan(&txID)
		if err != nil {
			return 0, false, fmt.Errorf("lookup tx: %w", err)
		}
	}

	// Insert observation
	_, err = d.db.Exec(
		`INSERT INTO observations (tx_id, observer_id, observer_name, observer_iata, rssi, snr, score, direction, path_json, timestamp)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		txID, obs.ObserverID, obs.ObserverName, obs.ObserverIATA,
		obs.RSSI, obs.SNR, obs.Score, obs.Direction, obs.PathJSON, obs.Timestamp,
	)
	if err != nil {
		return txID, isNew, fmt.Errorf("insert obs: %w", err)
	}

	// Update observation_count
	if !isNew {
		d.db.Exec(`UPDATE transmissions SET observation_count = observation_count + 1 WHERE id = ?`, txID)
	}

	return txID, isNew, nil
}

// UpsertNode inserts or updates a node from an ADVERT packet.
func (d *DB) UpsertNode(n *NodeRow) error {
	_, err := d.db.Exec(
		`INSERT INTO nodes (pub_key, name, role, lat, lon, last_seen, first_seen, advert_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(pub_key) DO UPDATE SET
		   name         = excluded.name,
		   role         = excluded.role,
		   lat          = COALESCE(excluded.lat, lat),
		   lon          = COALESCE(excluded.lon, lon),
		   last_seen    = excluded.last_seen,
		   advert_count = advert_count + 1`,
		n.PubKey, n.Name, n.Role, n.Lat, n.Lon, n.LastSeen, n.LastSeen,
	)
	return err
}

// UpdateNodeTelemetry updates battery and temperature for a node.
func (d *DB) UpdateNodeTelemetry(pubKey string, battMv *int, tempC *float64) error {
	_, err := d.db.Exec(
		`UPDATE nodes SET battery_mv = COALESCE(?, battery_mv), temperature_c = COALESCE(?, temperature_c) WHERE pub_key = ?`,
		battMv, tempC, pubKey,
	)
	return err
}

// UpsertObserver inserts or updates an observer from an MQTT message.
func (d *DB) UpsertObserver(id, name, iata, now string, meta *ObserverMeta) error {
	_, err := d.db.Exec(
		`INSERT INTO observers (id, name, iata, last_seen, first_seen, packet_count)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(id) DO UPDATE SET
		   name         = COALESCE(NULLIF(excluded.name,''), name),
		   iata         = COALESCE(NULLIF(excluded.iata,''), iata),
		   last_seen    = excluded.last_seen,
		   packet_count = packet_count + 1`,
		id, name, iata, now, now,
	)
	if err != nil {
		return err
	}
	if meta != nil {
		_, err = d.db.Exec(
			`UPDATE observers SET
			   model       = COALESCE(?, model),
			   firmware    = COALESCE(?, firmware),
			   battery_mv  = COALESCE(?, battery_mv),
			   uptime_secs = COALESCE(?, uptime_secs),
			   noise_floor = COALESCE(?, noise_floor)
			 WHERE id = ?`,
			meta.Model, meta.Firmware, meta.BatteryMv, meta.UptimeSecs, meta.NoiseFloor, id,
		)
	}
	return err
}

// LoadAll loads all rows for server startup.
func (d *DB) LoadAll() ([]*TxRow, []*ObsRow, []*NodeRow, []*ObserverRow, error) {
	txs, err := d.loadTxs(`SELECT id, raw_hex, hash, first_seen, route_type, payload_type, decoded_json, observation_count, COALESCE(channel_hash,'') FROM transmissions ORDER BY id ASC`)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	obss, err := d.loadObs(`SELECT id, tx_id, observer_id, COALESCE(observer_name,''), COALESCE(observer_iata,''), rssi, snr, score, COALESCE(direction,''), COALESCE(path_json,'[]'), timestamp FROM observations ORDER BY id ASC`)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	nodes, err := d.loadNodes()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	obs, err := d.loadObservers()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return txs, obss, nodes, obs, nil
}

// LoadSince loads packets with id > afterID for polling.
func (d *DB) LoadSince(afterTxID, afterObsID int64) ([]*TxRow, []*ObsRow, error) {
	txs, err := d.loadTxs(fmt.Sprintf(
		`SELECT id, raw_hex, hash, first_seen, route_type, payload_type, decoded_json, observation_count, COALESCE(channel_hash,'') FROM transmissions WHERE id > %d ORDER BY id ASC`,
		afterTxID,
	))
	if err != nil {
		return nil, nil, err
	}
	obss, err := d.loadObs(fmt.Sprintf(
		`SELECT id, tx_id, observer_id, COALESCE(observer_name,''), COALESCE(observer_iata,''), rssi, snr, score, COALESCE(direction,''), COALESCE(path_json,'[]'), timestamp FROM observations WHERE id > %d ORDER BY id ASC`,
		afterObsID,
	))
	if err != nil {
		return nil, nil, err
	}
	return txs, obss, nil
}

func (d *DB) loadTxs(query string) ([]*TxRow, error) {
	rows, err := d.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*TxRow
	for rows.Next() {
		var r TxRow
		if err := rows.Scan(&r.ID, &r.RawHex, &r.Hash, &r.FirstSeen, &r.RouteType, &r.PayloadType, &r.DecodedJSON, &r.ObsCount, &r.ChannelHash); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (d *DB) loadObs(query string) ([]*ObsRow, error) {
	rows, err := d.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ObsRow
	for rows.Next() {
		var r ObsRow
		if err := rows.Scan(&r.ID, &r.TxID, &r.ObserverID, &r.ObserverName, &r.ObserverIATA, &r.RSSI, &r.SNR, &r.Score, &r.Direction, &r.PathJSON, &r.Timestamp); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (d *DB) loadNodes() ([]*NodeRow, error) {
	rows, err := d.db.Query(`SELECT pub_key, COALESCE(name,''), COALESCE(role,''), lat, lon, COALESCE(last_seen,''), COALESCE(first_seen,''), advert_count, battery_mv, temperature_c FROM nodes ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*NodeRow
	for rows.Next() {
		var r NodeRow
		if err := rows.Scan(&r.PubKey, &r.Name, &r.Role, &r.Lat, &r.Lon, &r.LastSeen, &r.FirstSeen, &r.AdvertCount, &r.BatteryMv, &r.TempC); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (d *DB) loadObservers() ([]*ObserverRow, error) {
	rows, err := d.db.Query(`SELECT id, COALESCE(name,''), COALESCE(iata,''), COALESCE(last_seen,''), COALESCE(first_seen,''), packet_count, COALESCE(model,''), COALESCE(firmware,''), battery_mv, uptime_secs, noise_floor FROM observers ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ObserverRow
	for rows.Next() {
		var r ObserverRow
		if err := rows.Scan(&r.ID, &r.Name, &r.IATA, &r.LastSeen, &r.FirstSeen, &r.PktCount, &r.Model, &r.Firmware, &r.BatteryMv, &r.UptimeSecs, &r.NoiseFloor); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// LoadNodeUpdates loads nodes updated since a timestamp.
func (d *DB) LoadNodeUpdates(since string) ([]*NodeRow, error) {
	return d.loadNodes() // simplified: always return all
}

// LoadObserverUpdates loads observers updated since a timestamp.
func (d *DB) LoadObserverUpdates(since string) ([]*ObserverRow, error) {
	return d.loadObservers()
}

func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
