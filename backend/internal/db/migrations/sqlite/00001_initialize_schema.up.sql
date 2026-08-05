CREATE TABLE IF NOT EXISTS transmissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_hex TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    first_seen TEXT NOT NULL,
    route_type INTEGER,
    payload_type INTEGER,
    decoded_json TEXT,
    observation_count INTEGER NOT NULL DEFAULT 1,
    channel_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_first_seen ON transmissions(first_seen);

CREATE INDEX IF NOT EXISTS idx_tx_payload_type ON transmissions(payload_type);

CREATE INDEX IF NOT EXISTS idx_tx_channel_hash ON transmissions(channel_hash)
WHERE channel_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id INTEGER NOT NULL REFERENCES transmissions(id),
    observer_id TEXT NOT NULL,
    observer_name TEXT,
    observer_iata TEXT,
    rssi REAL,
    snr REAL,
    score REAL,
    direction TEXT,
    path_json TEXT,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_tx_id ON observations(tx_id);

CREATE INDEX IF NOT EXISTS idx_obs_observer ON observations(observer_id);

CREATE TABLE IF NOT EXISTS nodes (
    pub_key TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    lat REAL,
    lon REAL,
    last_seen TEXT,
    first_seen TEXT,
    advert_count INTEGER NOT NULL DEFAULT 0,
    battery_mv INTEGER,
    temperature_c REAL
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen);

CREATE TABLE IF NOT EXISTS observers (
    id TEXT PRIMARY KEY,
    name TEXT,
    iata TEXT,
    last_seen TEXT,
    first_seen TEXT,
    packet_count INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    firmware TEXT,
    battery_mv INTEGER,
    uptime_secs INTEGER,
    noise_floor REAL
);
