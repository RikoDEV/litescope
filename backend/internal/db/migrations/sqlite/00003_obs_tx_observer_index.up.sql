-- WriteBatch checks, for every observation of an already-known transmission,
-- whether that observer has reported it before (WHERE tx_id = ? AND
-- observer_id = ?). With only the two single-column indexes SQLite picked
-- idx_obs_observer and walked every observation that observer ever made, so the
-- ingestor's per-message cost grew with the size of the table until it could no
-- longer keep up with the broker. The composite index makes it a point lookup;
-- it also covers everything idx_obs_tx_id was used for (tx_id is its prefix).
CREATE INDEX IF NOT EXISTS idx_obs_tx_observer ON observations(tx_id, observer_id);

DROP INDEX IF EXISTS idx_obs_tx_id;
