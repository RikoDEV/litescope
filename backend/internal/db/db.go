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
	ID          int64
	RawHex      string
	Hash        string
	FirstSeen   string
	RouteType   int
	PayloadType int
	DecodedJSON string
	ObsCount    int
	ChannelHash string
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
	FloodScope   string
	Timestamp    string
	RawHex       string
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

type ObserverMeta struct {
	Model      *string
	Firmware   *string
	BatteryMv  *int
	UptimeSecs *int64
	NoiseFloor *float64
}

func Open(path string) (*DB, error) {
	// modernc.org/sqlite only honors `_pragma=name(value)` DSN params (the
	// `_journal_mode=...` form is mattn/go-sqlite3 syntax and is silently
	// ignored). WAL + busy_timeout are load-bearing here: the ingestor writes
	// while the server polls the same file every second.
	//
	// synchronous=NORMAL is the recommended pairing with WAL: commits no longer
	// fsync the WAL on every transaction (only at checkpoint), which is the bulk
	// of the ingestor's per-packet cost on a busy mesh. The DB stays consistent
	// across application crashes; only the last few commits can be lost on an OS
	// crash / power loss, which is acceptable for re-fetchable telemetry.
	connStr := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)", path)
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
			flood_scope   TEXT,
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
	// One-time migrations, gated on PRAGMA user_version. The recalculation below
	// rewrites every row of transmissions with a correlated subquery; it
	// previously ran on every ingestor AND server startup, stalling boot and
	// making the read-only server contend with the live ingestor for the single
	// writer. Run it (and the additive column migrations) once, then bump the
	// version so subsequent starts skip it.
	var userVersion int
	d.db.QueryRow(`PRAGMA user_version`).Scan(&userVersion)
	if userVersion < 1 {
		// Additive columns shipped after the initial schema (idempotent: adding an
		// existing column errors harmlessly and is ignored).
		d.db.Exec(`ALTER TABLE observations ADD COLUMN flood_scope TEXT`)
		d.db.Exec(`ALTER TABLE observations ADD COLUMN raw_hex TEXT`)
		// Recalculate observation_count to reflect unique observers (not raw row count).
		d.db.Exec(`UPDATE transmissions SET observation_count = (SELECT COUNT(DISTINCT observer_id) FROM observations WHERE tx_id = transmissions.id)`)
		d.db.Exec(`PRAGMA user_version = 1`)
	}
	return nil
}

// WriteItem is one unit of work for WriteBatch. Any subset of fields may be
// set: a packet sets Tx+Obs (plus Observer, plus Node for valid adverts); an
// observer status message sets only Observer.
type WriteItem struct {
	Tx          *TxRow
	Obs         *ObsRow
	Node        *NodeRow
	NodeBattery *int
	NodeTempC   *float64
	Observer    *ObserverUpsert
}

// ObserverUpsert carries an observers-table upsert. Meta is set only by observer
// status messages (model/firmware/battery/uptime/noise_floor).
type ObserverUpsert struct {
	ID, Name, IATA, Now string
	Meta                *ObserverMeta
}

// WriteBatch applies a batch of writes in a single transaction.
//
// This is the ingestor's main throughput lever. Previously every MQTT message
// paid its own transmission-insert transaction AND its own observer-upsert
// transaction (and adverts two more), so a packet seen by K observers cost ~2K
// commits of largely redundant data. Folding a batch into one transaction
// issues one commit (and, with synchronous=NORMAL, fsyncs only at checkpoint),
// and statements are prepared once per batch so modernc parses each SQL string
// once instead of once per row.
//
// observation_count semantics are preserved: it counts unique observers, so a
// repeat observation from an already-seen observer of an existing transmission
// does not bump it.
func (d *DB) WriteBatch(items []*WriteItem) error {
	if len(items) == 0 {
		return nil
	}
	var needTx, needNode, needObsv, needObsvMeta bool
	for _, it := range items {
		if it.Tx != nil {
			needTx = true
		}
		if it.Node != nil {
			needNode = true
		}
		if it.Observer != nil {
			needObsv = true
			if it.Observer.Meta != nil {
				needObsvMeta = true
			}
		}
	}

	dbtx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer dbtx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	// Statements prepared once per batch (closed by the deferred loop below);
	// modernc then parses each SQL string once per flush instead of once per row.
	var insTx, selTx, insObs, cntObs, bumpCnt, upNode, telNode, upObsv, upObsvMeta *sql.Stmt
	defer func() {
		for _, s := range []*sql.Stmt{insTx, selTx, insObs, cntObs, bumpCnt, upNode, telNode, upObsv, upObsvMeta} {
			if s != nil {
				s.Close()
			}
		}
	}()

	if needTx {
		if insTx, err = dbtx.Prepare(`INSERT OR IGNORE INTO transmissions (raw_hex, hash, first_seen, route_type, payload_type, decoded_json, channel_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`); err != nil {
			return fmt.Errorf("prepare tx: %w", err)
		}
		if selTx, err = dbtx.Prepare(`SELECT id FROM transmissions WHERE hash = ?`); err != nil {
			return fmt.Errorf("prepare tx-id: %w", err)
		}
		if insObs, err = dbtx.Prepare(`INSERT INTO observations (tx_id, observer_id, observer_name, observer_iata, rssi, snr, score, direction, path_json, flood_scope, timestamp, raw_hex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`); err != nil {
			return fmt.Errorf("prepare obs: %w", err)
		}
		if cntObs, err = dbtx.Prepare(`SELECT COUNT(*) FROM observations WHERE tx_id = ? AND observer_id = ?`); err != nil {
			return fmt.Errorf("prepare obs-count: %w", err)
		}
		if bumpCnt, err = dbtx.Prepare(`UPDATE transmissions SET observation_count = observation_count + 1 WHERE id = ?`); err != nil {
			return fmt.Errorf("prepare bump: %w", err)
		}
	}
	if needNode {
		if upNode, err = dbtx.Prepare(`INSERT INTO nodes (pub_key, name, role, lat, lon, last_seen, first_seen, advert_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(pub_key) DO UPDATE SET name = excluded.name, role = excluded.role, lat = COALESCE(excluded.lat, lat), lon = COALESCE(excluded.lon, lon), last_seen = excluded.last_seen, advert_count = advert_count + 1`); err != nil {
			return fmt.Errorf("prepare node: %w", err)
		}
		if telNode, err = dbtx.Prepare(`UPDATE nodes SET battery_mv = COALESCE(?, battery_mv), temperature_c = COALESCE(?, temperature_c) WHERE pub_key = ?`); err != nil {
			return fmt.Errorf("prepare node-tel: %w", err)
		}
	}
	if needObsv {
		if upObsv, err = dbtx.Prepare(`INSERT INTO observers (id, name, iata, last_seen, first_seen, packet_count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name,''), name), iata = COALESCE(NULLIF(excluded.iata,''), iata), last_seen = excluded.last_seen, packet_count = packet_count + 1`); err != nil {
			return fmt.Errorf("prepare observer: %w", err)
		}
	}
	if needObsvMeta {
		if upObsvMeta, err = dbtx.Prepare(`UPDATE observers SET model = COALESCE(?, model), firmware = COALESCE(?, firmware), battery_mv = COALESCE(?, battery_mv), uptime_secs = COALESCE(?, uptime_secs), noise_floor = COALESCE(?, noise_floor) WHERE id = ?`); err != nil {
			return fmt.Errorf("prepare observer-meta: %w", err)
		}
	}

	for _, it := range items {
		if it.Tx != nil && it.Obs != nil {
			tx, obs := it.Tx, it.Obs
			res, err := insTx.Exec(tx.RawHex, tx.Hash, tx.FirstSeen, tx.RouteType, tx.PayloadType, tx.DecodedJSON, nilIfEmpty(tx.ChannelHash))
			if err != nil {
				return fmt.Errorf("insert tx: %w", err)
			}
			var txID int64
			isNew := false
			if n, _ := res.RowsAffected(); n > 0 {
				txID, _ = res.LastInsertId()
				isNew = true
			} else if err = selTx.QueryRow(tx.Hash).Scan(&txID); err != nil {
				return fmt.Errorf("lookup tx: %w", err)
			}
			if _, err := insObs.Exec(txID, obs.ObserverID, obs.ObserverName, obs.ObserverIATA, obs.RSSI, obs.SNR, obs.Score, obs.Direction, obs.PathJSON, nilIfEmpty(obs.FloodScope), obs.Timestamp, nilIfEmpty(obs.RawHex)); err != nil {
				return fmt.Errorf("insert obs: %w", err)
			}
			// observation_count tracks unique observers; bump only when this is the
			// first observation of an existing transmission from this observer.
			if !isNew {
				var c int
				cntObs.QueryRow(txID, obs.ObserverID).Scan(&c)
				if c == 1 {
					bumpCnt.Exec(txID)
				}
			}
		}
		if it.Node != nil {
			n := it.Node
			normalizeNodeLocation(n)
			if _, err := upNode.Exec(n.PubKey, n.Name, n.Role, n.Lat, n.Lon, n.LastSeen, n.LastSeen); err != nil {
				return fmt.Errorf("upsert node: %w", err)
			}
			if it.NodeBattery != nil || it.NodeTempC != nil {
				telNode.Exec(it.NodeBattery, it.NodeTempC, n.PubKey)
			}
		}
		if it.Observer != nil {
			ob := it.Observer
			if _, err := upObsv.Exec(ob.ID, ob.Name, ob.IATA, ob.Now, ob.Now); err != nil {
				return fmt.Errorf("upsert observer: %w", err)
			}
			if ob.Meta != nil {
				m := ob.Meta
				upObsvMeta.Exec(m.Model, m.Firmware, m.BatteryMv, m.UptimeSecs, m.NoiseFloor, ob.ID)
			}
		}
	}

	if err := dbtx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func normalizeNodeLocation(n *NodeRow) {
	if n == nil || n.Lat == nil || n.Lon == nil || *n.Lat == 0 || *n.Lon == 0 {
		if n != nil {
			n.Lat = nil
			n.Lon = nil
		}
	}
}

// LoadAll loads all rows for server startup.
func (d *DB) LoadAll() ([]*TxRow, []*ObsRow, []*NodeRow, []*ObserverRow, error) {
	txs, err := d.loadTxs(`SELECT id, raw_hex, hash, first_seen, route_type, payload_type, decoded_json, observation_count, COALESCE(channel_hash,'') FROM transmissions ORDER BY id ASC`)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	obss, err := d.loadObs(`SELECT id, tx_id, observer_id, COALESCE(observer_name,''), COALESCE(observer_iata,''), rssi, snr, score, COALESCE(direction,''), COALESCE(path_json,'[]'), COALESCE(flood_scope,''), timestamp, COALESCE(raw_hex,'') FROM observations ORDER BY id ASC`)
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
	txs, err := d.loadTxs(
		`SELECT id, raw_hex, hash, first_seen, route_type, payload_type, decoded_json, observation_count, COALESCE(channel_hash,'') FROM transmissions WHERE id > ? ORDER BY id ASC`,
		afterTxID,
	)
	if err != nil {
		return nil, nil, err
	}
	obss, err := d.loadObs(
		`SELECT id, tx_id, observer_id, COALESCE(observer_name,''), COALESCE(observer_iata,''), rssi, snr, score, COALESCE(direction,''), COALESCE(path_json,'[]'), COALESCE(flood_scope,''), timestamp, COALESCE(raw_hex,'') FROM observations WHERE id > ? ORDER BY id ASC`,
		afterObsID,
	)
	if err != nil {
		return nil, nil, err
	}
	return txs, obss, nil
}

func (d *DB) loadTxs(query string, args ...any) ([]*TxRow, error) {
	rows, err := d.db.Query(query, args...)
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

func (d *DB) loadObs(query string, args ...any) ([]*ObsRow, error) {
	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ObsRow
	for rows.Next() {
		var r ObsRow
		if err := rows.Scan(&r.ID, &r.TxID, &r.ObserverID, &r.ObserverName, &r.ObserverIATA, &r.RSSI, &r.SNR, &r.Score, &r.Direction, &r.PathJSON, &r.FloodScope, &r.Timestamp, &r.RawHex); err != nil {
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

// LoadNodeUpdates reloads all node rows (the table is small enough to refresh
// wholesale on the server's periodic meta-refresh tick).
func (d *DB) LoadNodeUpdates() ([]*NodeRow, error) {
	return d.loadNodes()
}

// LoadObserverUpdates reloads all observer rows. See LoadNodeUpdates.
func (d *DB) LoadObserverUpdates() ([]*ObserverRow, error) {
	return d.loadObservers()
}

// RedecodeChannelMessages returns all GRP_TXT rows that still have decryptionStatus=no_key
// so the caller can re-decode them and call UpdateDecodedJSON to persist the result.
func (d *DB) UndecryptedChannelMessages() ([]*TxRow, error) {
	return d.loadTxs(`SELECT id, raw_hex, hash, first_seen, route_type, payload_type, decoded_json, observation_count, COALESCE(channel_hash,'') FROM transmissions WHERE payload_type = 5 AND decoded_json LIKE '%no_key%'`)
}

// UpdateDecodedJSON persists a new decoded_json value for a transmission row.
func (d *DB) UpdateDecodedJSON(id int64, decodedJSON string) error {
	_, err := d.db.Exec(`UPDATE transmissions SET decoded_json = ? WHERE id = ?`, decodedJSON, id)
	return err
}

// PruneOlderThan deletes transmissions (and their observations) first seen
// strictly before cutoff (RFC3339). Returns the number of transmissions removed.
// Nodes/observers are kept — their counters are lifetime cumulative totals.
func (d *DB) PruneOlderThan(cutoff string) (int64, error) {
	dbtx, err := d.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer dbtx.Rollback() //nolint:errcheck

	if _, err := dbtx.Exec(
		`DELETE FROM observations WHERE tx_id IN (SELECT id FROM transmissions WHERE first_seen < ?)`,
		cutoff,
	); err != nil {
		return 0, fmt.Errorf("prune obs: %w", err)
	}
	res, err := dbtx.Exec(`DELETE FROM transmissions WHERE first_seen < ?`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("prune tx: %w", err)
	}
	if err := dbtx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
