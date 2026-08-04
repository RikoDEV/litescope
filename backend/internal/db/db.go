package db

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
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
	// Scope is the TRANSPORT_FLOOD scope (config.scopeList) this specific ADVERT
	// resolved to, or "" if none. Write-path only — see decoder.ResolveFloodScope
	// and WriteBatch, which folds it into the node_scopes table.
	Scope string
	// Scopes is the full set of distinct scopes ever observed for this node
	// (sorted). Read-path only, populated by loadNodes/LoadNodeUpdates.
	Scopes []string
	// LastScope is the scope with the most recent last_seen among Scopes, or ""
	// if the node has no scopes. Read-path only.
	LastScope string
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

//go:embed migrations/sqlite/*.sql
var sqliteMigrations embed.FS

type migrateLogger struct {
	logger *log.Logger
}

func (l *migrateLogger) Printf(format string, v ...interface{}) {
	l.logger.Printf(format, v...)
}

func (l *migrateLogger) Verbose() bool {
	return false
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

	if err := d.migrate(); err != nil {
		return nil, err
	}

	return d, nil
}

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) migrate() error {
	sourceDriver, err := iofs.New(sqliteMigrations, "migrations/sqlite")

	if err != nil {
		return fmt.Errorf("iofs: %w", err)
	}

	dbDriver, err := sqlitemigrate.WithInstance(d.db, &sqlitemigrate.Config{})

	if err != nil {
		return fmt.Errorf("sqlitemigrate: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", sourceDriver, "sqlite", dbDriver)

	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	m.Log = &migrateLogger{
		logger: log.New(os.Stdout, "[migration] ", log.LstdFlags|log.Lmsgprefix),
	}

	var userVersion int
	d.db.QueryRow(`PRAGMA user_version`).Scan(&userVersion)

	// skip migrations if schema is already created with legacy mechanism
	if userVersion == 1 {
		d.db.Exec(`DELETE FROM schema_migrations`)
		d.db.Exec(`INSERT INTO schema_migrations (version, dirty) VALUES (2, 0)`)
		d.db.Exec(`PRAGMA user_version = 0`)
	}

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate: %w", err)
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
	var insTx, selTx, insObs, cntObs, bumpCnt, upNode, telNode, upNodeScope, upObsv, upObsvMeta *sql.Stmt
	defer func() {
		for _, s := range []*sql.Stmt{insTx, selTx, insObs, cntObs, bumpCnt, upNode, telNode, upNodeScope, upObsv, upObsvMeta} {
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
		if upNodeScope, err = dbtx.Prepare(`INSERT INTO node_scopes (pub_key, scope, last_seen) VALUES (?, ?, ?) ON CONFLICT(pub_key, scope) DO UPDATE SET last_seen = excluded.last_seen`); err != nil {
			return fmt.Errorf("prepare node-scope: %w", err)
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
			if n.Scope != "" {
				if _, err := upNodeScope.Exec(n.PubKey, n.Scope, n.LastSeen); err != nil {
					return fmt.Errorf("upsert node scope: %w", err)
				}
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	scopes, lastScope, err := d.loadNodeScopes()
	if err != nil {
		return nil, err
	}
	for _, n := range out {
		n.Scopes = scopes[n.PubKey]
		n.LastScope = lastScope[n.PubKey]
	}
	return out, nil
}

// loadNodeScopes returns every distinct TRANSPORT_FLOOD scope observed per
// node (sorted, keyed by pub_key — a node can advertise under several), plus
// the scope with the most recent last_seen per node. last_seen is RFC3339 UTC
// (see resolveRxTime), so lexicographic comparison matches chronological order.
func (d *DB) loadNodeScopes() (scopes map[string][]string, lastScope map[string]string, err error) {
	rows, err := d.db.Query(`SELECT pub_key, scope, COALESCE(last_seen,'') FROM node_scopes ORDER BY pub_key, scope`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	scopes = make(map[string][]string)
	lastScope = make(map[string]string)
	lastSeenMax := make(map[string]string)
	for rows.Next() {
		var pubKey, scope, lastSeen string
		if err := rows.Scan(&pubKey, &scope, &lastSeen); err != nil {
			return nil, nil, err
		}
		scopes[pubKey] = append(scopes[pubKey], scope)
		if lastSeen >= lastSeenMax[pubKey] {
			lastSeenMax[pubKey] = lastSeen
			lastScope[pubKey] = scope
		}
	}
	return scopes, lastScope, rows.Err()
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

// PruneDeadEntities deletes nodes and observers whose last_seen is strictly
// before cutoff (RFC3339). Unlike PruneOlderThan, this drops registry rows, not
// packets/observations — those are untouched, so historical transmissions keep
// referencing a pubkey/observer ID that no longer has a nodes/observers row.
// Returns the number of nodes and observers removed.
func (d *DB) PruneDeadEntities(cutoff string) (nodes int64, observers int64, err error) {
	nres, err := d.db.Exec(`DELETE FROM nodes WHERE last_seen <> '' AND last_seen < ?`, cutoff)
	if err != nil {
		return 0, 0, fmt.Errorf("prune nodes: %w", err)
	}
	ores, err := d.db.Exec(`DELETE FROM observers WHERE last_seen <> '' AND last_seen < ?`, cutoff)
	if err != nil {
		return 0, 0, fmt.Errorf("prune observers: %w", err)
	}
	nodes, _ = nres.RowsAffected()
	observers, _ = ores.RowsAffected()
	return nodes, observers, nil
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
