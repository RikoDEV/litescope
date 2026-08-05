package db

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// legacySchema is the DDL the pre-golang-migrate applySchema() produced, kept
// verbatim so the adoption path is tested against what real deployments have on
// disk rather than against the new migration files.
var legacySchema = []string{
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
	`CREATE TABLE IF NOT EXISTS node_scopes (
		pub_key   TEXT NOT NULL REFERENCES nodes(pub_key) ON DELETE CASCADE,
		scope     TEXT NOT NULL,
		last_seen TEXT,
		PRIMARY KEY (pub_key, scope)
	)`,
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
	`ALTER TABLE observations ADD COLUMN raw_hex TEXT`,
	`PRAGMA user_version = 1`,
}

func tempDBPath(t *testing.T) string {
	t.Helper()
	return filepath.ToSlash(filepath.Join(t.TempDir(), "test.db"))
}

func schemaVersion(t *testing.T, d *DB) (version uint, dirty bool) {
	t.Helper()
	if err := d.db.QueryRow(`SELECT version, dirty FROM schema_migrations LIMIT 1`).Scan(&version, &dirty); err != nil {
		t.Fatalf("read schema_migrations: %v", err)
	}
	return version, dirty
}

func TestOpenAndMigrateFreshDB(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	want, err := latestMigrationVersion()
	if err != nil {
		t.Fatalf("latestMigrationVersion: %v", err)
	}
	if got, dirty := schemaVersion(t, d); got != want || dirty {
		t.Fatalf("schema version = %d dirty=%v, want %d clean", got, dirty, want)
	}
	// The columns and table that migration 2 adds must be present.
	for _, q := range []string{
		`SELECT flood_scope, raw_hex FROM observations LIMIT 1`,
		`SELECT pub_key, scope, last_seen FROM node_scopes LIMIT 1`,
	} {
		if _, err := d.db.Exec(q); err != nil {
			t.Errorf("post-migration query %q: %v", q, err)
		}
	}
}

// TestOpenAndMigrateIsIdempotent guards the restart path: a second call must be
// a no-op, not a re-application that dirties the database.
func TestOpenAndMigrateIsIdempotent(t *testing.T) {
	path := tempDBPath(t)
	d1, err := OpenAndMigrate(path)
	if err != nil {
		t.Fatalf("first OpenAndMigrate: %v", err)
	}
	d1.Close()

	d2, err := OpenAndMigrate(path)
	if err != nil {
		t.Fatalf("second OpenAndMigrate: %v", err)
	}
	defer d2.Close()
	if _, dirty := schemaVersion(t, d2); dirty {
		t.Fatal("database dirty after reopening an already-migrated DB")
	}
}

// TestAdoptLegacySchema is the upgrade path that matters: a database created by
// the old applySchema() must be adopted at version 2 without re-running DDL,
// with its rows intact.
func TestAdoptLegacySchema(t *testing.T) {
	path := tempDBPath(t)

	raw, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=foreign_keys(1)", path))
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	for _, s := range legacySchema {
		if _, err := raw.Exec(s); err != nil {
			t.Fatalf("legacy DDL %.40q: %v", s, err)
		}
	}
	if _, err := raw.Exec(`INSERT INTO transmissions (raw_hex, hash, first_seen, observation_count) VALUES ('aa', 'h1', '2026-01-01T00:00:00Z', 3)`); err != nil {
		t.Fatalf("seed row: %v", err)
	}
	raw.Close()

	d, err := OpenAndMigrate(path)
	if err != nil {
		t.Fatalf("OpenAndMigrate on legacy DB: %v", err)
	}
	defer d.Close()

	if got, dirty := schemaVersion(t, d); got != 2 || dirty {
		t.Fatalf("schema version = %d dirty=%v, want 2 clean", got, dirty)
	}
	// user_version must be reset, otherwise the adoption branch re-fires on every
	// later start and stamps the version back down to 2.
	var userVersion int
	if err := d.db.QueryRow(`PRAGMA user_version`).Scan(&userVersion); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	if userVersion != 0 {
		t.Errorf("user_version = %d, want 0", userVersion)
	}
	// Migration 2's recalculation must not have run: it would have rewritten
	// observation_count to 0 for a transmission with no observations.
	var count int
	if err := d.db.QueryRow(`SELECT observation_count FROM transmissions WHERE hash = 'h1'`).Scan(&count); err != nil {
		t.Fatalf("read seeded row: %v", err)
	}
	if count != 3 {
		t.Errorf("observation_count = %d, want 3 (migration 2 should have been skipped)", count)
	}
}

// TestOpenWaitsForMigration covers the server side: Open must not migrate, and
// must fail cleanly rather than hang forever when nothing ever migrates.
func TestOpenWaitsForMigration(t *testing.T) {
	path := tempDBPath(t)

	d, err := open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()

	start := time.Now()
	if err := d.awaitSchema(300 * time.Millisecond); err == nil {
		t.Fatal("awaitSchema succeeded on an unmigrated database, want timeout")
	}
	if elapsed := time.Since(start); elapsed < 300*time.Millisecond {
		t.Errorf("awaitSchema returned after %s, want it to wait the full timeout", elapsed)
	}
	// Open must not have created the schema as a side effect.
	if _, err := d.db.Exec(`SELECT 1 FROM transmissions LIMIT 1`); err == nil {
		t.Error("Open created the schema; only OpenAndMigrate may do that")
	}
}

// TestAwaitSchemaWaitsThroughTransientDirty pins the behaviour that CI caught:
// golang-migrate flips dirty on *before* each migration and off after, so an
// in-flight migration looks dirty. awaitSchema must wait it out, not fail.
// Driven deterministically rather than by racing a real migration.
func TestAwaitSchemaWaitsThroughTransientDirty(t *testing.T) {
	path := tempDBPath(t)
	d, err := OpenAndMigrate(path)
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	// Rewind to what golang-migrate writes just before applying migration 2.
	if _, err := d.db.Exec(`UPDATE schema_migrations SET version = 1, dirty = 1`); err != nil {
		t.Fatalf("simulate in-flight migration: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- d.awaitSchema(30 * time.Second) }()

	// Let the waiter observe the dirty state for several poll intervals, then
	// complete the "migration".
	time.Sleep(750 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("awaitSchema returned early while a migration was in flight: %v", err)
	default:
	}
	if _, err := d.db.Exec(`UPDATE schema_migrations SET version = 2, dirty = 0`); err != nil {
		t.Fatalf("complete migration: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("awaitSchema after migration completed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("awaitSchema did not return after the migration completed")
	}
}

// TestAwaitSchemaTimesOutWhenStuckDirty is the other half: a database left dirty
// must still terminate, with a message that tells the operator what to force.
func TestAwaitSchemaTimesOutWhenStuckDirty(t *testing.T) {
	path := tempDBPath(t)
	d, err := OpenAndMigrate(path)
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()

	if _, err := d.db.Exec(`UPDATE schema_migrations SET version = 1, dirty = 1`); err != nil {
		t.Fatalf("simulate wedged migration: %v", err)
	}
	err = d.awaitSchema(500 * time.Millisecond)
	if err == nil {
		t.Fatal("awaitSchema succeeded on a permanently dirty database")
	}
	if !strings.Contains(err.Error(), "dirty") || !strings.Contains(err.Error(), "version 1") {
		t.Errorf("error %q should name the dirty state and the stuck version", err)
	}
}

// TestConcurrentOpenAndMigrate is the regression test for the race this split
// exists to prevent: a server opening the same file while the ingestor migrates
// must end up with a clean, fully-migrated database.
func TestConcurrentOpenAndMigrate(t *testing.T) {
	path := tempDBPath(t)

	var wg sync.WaitGroup
	var migErr, readErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		d, err := OpenAndMigrate(path)
		if err != nil {
			migErr = err
			return
		}
		d.Close()
	}()
	go func() {
		defer wg.Done()
		d, err := open(path)
		if err != nil {
			readErr = err
			return
		}
		defer d.Close()
		readErr = d.awaitSchema(30 * time.Second)
	}()
	wg.Wait()

	if migErr != nil {
		t.Fatalf("migrating side: %v", migErr)
	}
	if readErr != nil {
		t.Fatalf("waiting side: %v", readErr)
	}

	d, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer d.Close()
	if _, dirty := schemaVersion(t, d); dirty {
		t.Fatal("database dirty after concurrent open")
	}
}
