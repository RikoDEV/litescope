DROP TABLE IF EXISTS observers;

DROP INDEX IF EXISTS idx_nodes_last_seen;

DROP TABLE IF EXISTS nodes;

DROP INDEX IF EXISTS idx_obs_observer;

DROP INDEX IF EXISTS idx_obs_tx_id;

DROP TABLE IF EXISTS observations;

DROP INDEX IF EXISTS idx_tx_channel_hash;

DROP INDEX IF EXISTS idx_tx_payload_type;

DROP INDEX IF EXISTS idx_tx_first_seen;

DROP TABLE IF EXISTS transmissions;
