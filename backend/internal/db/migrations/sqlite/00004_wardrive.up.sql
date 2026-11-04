-- Wardrive coverage pings submitted by the MeshMapper app's "Custom API"
-- endpoint (issue #114). One row per ping; the repeaters that heard it live in
-- wardrive_hears. ts is the ping's own Unix-seconds timestamp.
--
-- device_hash is sha256(salt || contact) — the raw contact key prefix is never
-- stored. '' (not NULL) when the app omitted it, so the dedupe index below still
-- collapses re-sent offline chunks (NULLs are distinct in a UNIQUE index).
CREATE TABLE IF NOT EXISTS wardrive_samples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    type        TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    iata        TEXT    NOT NULL DEFAULT '',
    noisefloor  INTEGER,
    radio_freq  TEXT    NOT NULL DEFAULT '',
    device_hash TEXT    NOT NULL DEFAULT '',
    received_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wardrive_dedupe ON wardrive_samples(device_hash, type, ts, lat, lon);
CREATE INDEX IF NOT EXISTS idx_wardrive_ts ON wardrive_samples(ts);

CREATE TABLE IF NOT EXISTS wardrive_hears (
    sample_id       INTEGER NOT NULL REFERENCES wardrive_samples(id) ON DELETE CASCADE,
    repeater_prefix TEXT    NOT NULL,
    snr             REAL,
    rssi            INTEGER,
    remote_snr      REAL
);

CREATE INDEX IF NOT EXISTS idx_wardrive_hears_sample ON wardrive_hears(sample_id);
CREATE INDEX IF NOT EXISTS idx_wardrive_hears_prefix ON wardrive_hears(repeater_prefix);

-- Small key/value table for wardrive state (the device-hash salt).
CREATE TABLE IF NOT EXISTS wardrive_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
