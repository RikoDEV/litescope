-- Pre-aggregated statistics maintained by the ingestor on every write (see
-- db.WriteBatch). They let the server answer all-time / long-window questions
-- (home totals, RF summary, 30-day observer analytics, the channel list, node
-- regions) without keeping the whole packet history in RAM, and they survive
-- retention pruning of the raw rows.
--
-- `hour` is the Unix-seconds start of the UTC hour. SNR histogram bins are
-- 4 dB wide over [-25, 15): bin = clamp(floor((snr + 25) / 4), 0, 9) — the
-- same bins the observer SNR chart uses (bucketize(snr, -25, 15, 10)).

-- New transmissions per hour and payload type (keyed on first_seen).
CREATE TABLE IF NOT EXISTS rollup_tx_hourly (
    hour         INTEGER NOT NULL,
    payload_type INTEGER NOT NULL,
    tx_count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, payload_type)
) WITHOUT ROWID;

-- Observations per hour, observer and payload type (keyed on the observation
-- timestamp), with RF aggregates.
CREATE TABLE IF NOT EXISTS rollup_obs_hourly (
    hour         INTEGER NOT NULL,
    observer_id  TEXT    NOT NULL,
    payload_type INTEGER NOT NULL,
    obs_count    INTEGER NOT NULL DEFAULT 0,
    snr_n        INTEGER NOT NULL DEFAULT 0,
    snr_sum      REAL    NOT NULL DEFAULT 0,
    snr_min      REAL,
    snr_max      REAL,
    rssi_n       INTEGER NOT NULL DEFAULT 0,
    rssi_sum     REAL    NOT NULL DEFAULT 0,
    rssi_min     REAL,
    rssi_max     REAL,
    snr_h0 INTEGER NOT NULL DEFAULT 0, snr_h1 INTEGER NOT NULL DEFAULT 0,
    snr_h2 INTEGER NOT NULL DEFAULT 0, snr_h3 INTEGER NOT NULL DEFAULT 0,
    snr_h4 INTEGER NOT NULL DEFAULT 0, snr_h5 INTEGER NOT NULL DEFAULT 0,
    snr_h6 INTEGER NOT NULL DEFAULT 0, snr_h7 INTEGER NOT NULL DEFAULT 0,
    snr_h8 INTEGER NOT NULL DEFAULT 0, snr_h9 INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, observer_id, payload_type)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rollup_obs_observer ON rollup_obs_hourly(observer_id, hour);

-- All-time GRP_TXT totals per channel hash, and its decrypted name.
CREATE TABLE IF NOT EXISTS rollup_channels (
    channel_hash TEXT PRIMARY KEY,
    total        INTEGER NOT NULL DEFAULT 0,
    decrypted    INTEGER NOT NULL DEFAULT 0,
    name         TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;

-- Observer regions (IATA) that heard each node's adverts, with counts.
CREATE TABLE IF NOT EXISTS rollup_node_regions (
    pub_key   TEXT    NOT NULL,
    iata      TEXT    NOT NULL,
    obs_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pub_key, iata)
) WITHOUT ROWID;

-- ── Backfill from existing rows (one-time; may take a while on a large DB) ──

INSERT INTO rollup_tx_hourly (hour, payload_type, tx_count)
SELECT (CAST(strftime('%s', first_seen) AS INTEGER) / 3600) * 3600, COALESCE(payload_type, -1), COUNT(*)
FROM transmissions
WHERE strftime('%s', first_seen) IS NOT NULL
GROUP BY 1, 2;

INSERT INTO rollup_obs_hourly (
    hour, observer_id, payload_type, obs_count,
    snr_n, snr_sum, snr_min, snr_max, rssi_n, rssi_sum, rssi_min, rssi_max,
    snr_h0, snr_h1, snr_h2, snr_h3, snr_h4, snr_h5, snr_h6, snr_h7, snr_h8, snr_h9)
SELECT
    (CAST(strftime('%s', o.timestamp) AS INTEGER) / 3600) * 3600,
    o.observer_id,
    COALESCE(t.payload_type, -1),
    COUNT(*),
    COUNT(o.snr), TOTAL(o.snr), MIN(o.snr), MAX(o.snr),
    COUNT(o.rssi), TOTAL(o.rssi), MIN(o.rssi), MAX(o.rssi),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 0),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 1),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 2),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 3),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 4),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 5),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 6),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 7),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 8),
    SUM(o.snr IS NOT NULL AND MIN(9, MAX(0, CAST(((o.snr + 25) / 4.0) AS INTEGER))) = 9)
FROM observations o
JOIN transmissions t ON t.id = o.tx_id
WHERE strftime('%s', o.timestamp) IS NOT NULL
GROUP BY 1, 2, 3;

INSERT INTO rollup_channels (channel_hash, total, decrypted, name)
SELECT
    channel_hash,
    COUNT(*),
    SUM(json_extract(decoded_json, '$.decryptionStatus') = 'decrypted'),
    COALESCE(MAX(NULLIF(json_extract(decoded_json, '$.channel'), '')), '')
FROM transmissions
WHERE payload_type = 5 AND channel_hash IS NOT NULL AND channel_hash <> ''
GROUP BY channel_hash;

INSERT INTO rollup_node_regions (pub_key, iata, obs_count)
SELECT json_extract(t.decoded_json, '$.pubKey'), o.observer_iata, COUNT(*)
FROM transmissions t
JOIN observations o ON o.tx_id = t.id
WHERE t.payload_type = 4
  AND json_extract(t.decoded_json, '$.pubKey') IS NOT NULL
  AND json_extract(t.decoded_json, '$.pubKey') <> ''
  AND o.observer_iata IS NOT NULL AND o.observer_iata <> ''
GROUP BY 1, 2;
