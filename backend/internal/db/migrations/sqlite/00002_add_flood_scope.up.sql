ALTER TABLE observations ADD COLUMN flood_scope TEXT;
ALTER TABLE observations ADD COLUMN raw_hex TEXT;
UPDATE transmissions SET observation_count = (SELECT COUNT(DISTINCT observer_id) FROM observations WHERE tx_id = transmissions.id);
