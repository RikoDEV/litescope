CREATE INDEX IF NOT EXISTS idx_obs_tx_id ON observations(tx_id);

DROP INDEX IF EXISTS idx_obs_tx_observer;
