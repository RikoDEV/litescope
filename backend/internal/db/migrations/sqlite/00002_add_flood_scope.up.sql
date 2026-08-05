ALTER TABLE observations ADD COLUMN flood_scope TEXT;
ALTER TABLE observations ADD COLUMN raw_hex TEXT;

-- A node can advertise under several TRANSPORT_FLOOD scopes over time (it
-- isn't limited to one), so scopes are a separate one-to-many table rather
-- than a single column on nodes.
CREATE TABLE IF NOT EXISTS node_scopes (
    pub_key TEXT NOT NULL REFERENCES nodes(pub_key) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    last_seen TEXT,
    PRIMARY KEY (pub_key, scope)
);

UPDATE transmissions SET observation_count = (SELECT COUNT(DISTINCT observer_id) FROM observations WHERE tx_id = transmissions.id);
