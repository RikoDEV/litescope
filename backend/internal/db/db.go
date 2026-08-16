package db

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
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

const migrationsDir = "migrations/sqlite"

// schemaWaitTimeout bounds how long Open waits for the migrating process to
// bring the schema up to the version this binary was built against. Sized for
// the worst realistic case: migration 2's observation_count recalculation is a
// correlated subquery over the whole transmissions table, which takes tens of
// seconds on a long-lived deployment.
const schemaWaitTimeout = 5 * time.Minute

// migrateBusyTimeout bounds how long OpenAndMigrate retries while another
// process holds the database. See migrate().
const migrateBusyTimeout = 2 * time.Minute

type migrateLogger struct {
	logger *log.Logger
}

func (l *migrateLogger) Printf(format string, v ...any) {
	l.logger.Printf(format, v...)
}

func (l *migrateLogger) Verbose() bool {
	return false
}

// OpenAndMigrate opens the database and applies any pending schema migrations.
//
// Exactly one process may call this. golang-migrate's SQLite driver has no
// cross-process lock (its Lock() is an in-process flag), so two binaries racing
// m.Up() on the same file can both read version 0, both apply migration 2, and
// the loser dies on `duplicate column name: flood_scope` — which marks
// schema_migrations.dirty and wedges every subsequent start until an operator
// runs `force`. The ingestor is the only writer (see WriteBatch), so it owns
// migrations; the server uses Open and waits.
func OpenAndMigrate(path string) (*DB, error) {
	d, err := open(path)
	if err != nil {
		return nil, err
	}
	if err := d.migrate(); err != nil {
		d.db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return d, nil
}

// Open opens the database without touching the schema, blocking until the
// migrating process (see OpenAndMigrate) has brought it up to the version this
// binary expects. On a first boot the DB file may not exist yet, or may exist
// with no tables; both are treated as "not ready" rather than an error.
func Open(path string) (*DB, error) {
	d, err := open(path)
	if err != nil {
		return nil, err
	}
	if err := d.awaitSchema(schemaWaitTimeout); err != nil {
		d.db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return d, nil
}

func open(path string) (*DB, error) {
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
	return &DB{db: db}, nil
}

func (d *DB) Close() error { return d.db.Close() }

// migrate applies pending migrations, retrying while the database is busy.
//
// The retry is not belt-and-braces: golang-migrate's SQLite driver does not
// honour the connection's busy_timeout, so WithInstance fails *immediately* with
// SQLITE_BUSY if anything else is reading the file at that moment — which the
// server does, once a second, forever. Without this the ingestor would lose
// startup races against a server that is merely polling.
func (d *DB) migrate() error {
	deadline := time.Now().Add(migrateBusyTimeout)
	for attempt := 1; ; attempt++ {
		err := d.migrateOnce()
		if err == nil || !isBusy(err) || time.Now().After(deadline) {
			return err
		}
		if attempt == 1 {
			log.Printf("database busy, retrying migration...")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// isBusy reports whether err is (or wraps) SQLITE_BUSY. golang-migrate flattens
// some driver errors into plain strings, hence the textual fallback.
func isBusy(err error) bool {
	if serr, ok := errors.AsType[*sqlite.Error](err); ok {
		return serr.Code() == sqlite3.SQLITE_BUSY
	}
	s := err.Error()
	return strings.Contains(s, "SQLITE_BUSY") || strings.Contains(s, "database is locked")
}

func (d *DB) migrateOnce() error {
	sourceDriver, err := iofs.New(sqliteMigrations, migrationsDir)
	if err != nil {
		return fmt.Errorf("iofs: %w", err)
	}
	// WithInstance creates schema_migrations if absent, so the legacy stamp
	// below can assume the table exists.
	dbDriver, err := sqlitemigrate.WithInstance(d.db, &sqlitemigrate.Config{})
	if err != nil {
		return fmt.Errorf("sqlitemigrate: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", sourceDriver, "sqlite", dbDriver)
	if err != nil {
		return fmt.Errorf("new: %w", err)
	}
	m.Log = &migrateLogger{
		logger: log.New(os.Stdout, "[migration] ", log.LstdFlags|log.Lmsgprefix),
	}

	if err := d.adoptLegacySchema(); err != nil {
		return err
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("up: %w", err)
	}
	return nil
}

// adoptLegacySchema hands a database created by the pre-golang-migrate
// applySchema() over to the migration tool without re-running any DDL.
//
// That code CREATE-TABLE-IF-NOT-EXISTS'd the whole schema on every start and
// gated the additive bits (flood_scope, raw_hex, node_scopes, the
// observation_count recalculation) on `PRAGMA user_version < 1`, bumping the
// pragma to 1 afterwards. So user_version == 1 means "schema is equivalent to
// migrations 1+2, already applied" and we stamp exactly that.
//
// Errors here are fatal rather than ignored: if the stamp silently fails, m.Up()
// runs migration 2 against a schema that already has flood_scope, the ALTER
// fails, and golang-migrate marks the database dirty — turning a no-op upgrade
// into one that needs manual recovery.
//
// The three statements are one transaction because they must not be observed
// half-done. Resetting user_version to 0 is load-bearing, not cleanup: leaving
// it at 1 would re-trigger this branch on every subsequent start and clobber the
// version back down to 2 after migration 3 ships.
func (d *DB) adoptLegacySchema() error {
	var userVersion int
	if err := d.db.QueryRow(`PRAGMA user_version`).Scan(&userVersion); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	if userVersion != 1 {
		return nil
	}

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("legacy stamp begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once Commit succeeds

	for _, s := range []string{
		`DELETE FROM schema_migrations`,
		`INSERT INTO schema_migrations (version, dirty) VALUES (2, 0)`,
		`PRAGMA user_version = 0`,
	} {
		if _, err := tx.Exec(s); err != nil {
			return fmt.Errorf("legacy stamp %q: %w", s, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("legacy stamp commit: %w", err)
	}
	log.Printf("adopted legacy schema (user_version=1) as migration version 2")
	return nil
}

// awaitSchema blocks until schema_migrations reports a clean version at least as
// new as the newest embedded migration.
//
// Every not-ready condition is retried, dirty included. That is deliberate:
// golang-migrate sets dirty BEFORE applying a migration and clears it after, so
// a healthy migration in flight is indistinguishable from a wedged one by the
// flag alone — and the window is widest during migration 2's whole-table
// recalculation, i.e. exactly when the server is most likely to be polling.
// Failing fast on dirty turned a normal concurrent start into a hard error.
//
// A genuinely wedged database therefore surfaces as the timeout below, whose
// message names the version it was stuck at so the operator knows what to force.
func (d *DB) awaitSchema(timeout time.Duration) error {
	want, err := latestMigrationVersion()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	logged := false
	sawDirty := false
	dirtyAt := uint(0)
	for {
		var version uint
		var dirty bool
		err := d.db.QueryRow(`SELECT version, dirty FROM schema_migrations LIMIT 1`).Scan(&version, &dirty)
		switch {
		case err == nil && dirty:
			sawDirty, dirtyAt = true, version
		case err == nil && version >= want:
			return nil
		}
		if time.Now().After(deadline) {
			if sawDirty {
				return fmt.Errorf("timed out after %s: database stuck dirty at version %d — a migration failed part-way; resolve it and force the version before restarting", timeout, dirtyAt)
			}
			return fmt.Errorf("timed out after %s waiting for schema version %d (is the ingestor running?)", timeout, want)
		}
		if !logged {
			log.Printf("waiting for schema version %d to be applied by the ingestor...", want)
			logged = true
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// latestMigrationVersion returns the highest version among the embedded *.up.sql
// files, i.e. the schema version this binary was compiled against.
func latestMigrationVersion() (uint, error) {
	entries, err := fs.ReadDir(sqliteMigrations, migrationsDir)
	if err != nil {
		return 0, fmt.Errorf("read migrations: %w", err)
	}
	var latest uint
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		digits := name[:len(name)-len(strings.TrimLeft(name, "0123456789"))]
		v, err := strconv.ParseUint(digits, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("migration %q has no leading version number", name)
		}
		if uint(v) > latest {
			latest = uint(v)
		}
	}
	if latest == 0 {
		return 0, errors.New("no embedded migrations found")
	}
	return latest, nil
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
	if n == nil || n.Lat == nil || n.Lon == nil || (*n.Lat == 0 && *n.Lon == 0) {
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
