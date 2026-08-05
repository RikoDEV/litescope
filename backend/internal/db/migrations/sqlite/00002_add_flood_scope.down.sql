-- Note: the observation_count recalculation in the up migration is not
-- reversible — the pre-migration values (raw observation row counts rather than
-- distinct observers) are not recoverable. Rolling back leaves the corrected
-- counts in place, which the old code would recompute on its next start anyway.
DROP TABLE IF EXISTS node_scopes;

ALTER TABLE observations DROP COLUMN raw_hex;

ALTER TABLE observations DROP COLUMN flood_scope;
