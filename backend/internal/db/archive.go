package db

import (
	"database/sql"
	"strconv"
	"strings"
)

// The server keeps only a recent "hot window" of packets in memory (config
// memoryWindowDays). The window is a contiguous suffix of transmission ids, so
// "older than the window" is exactly `id < boundary`; these queries serve the
// reads that reach past it straight from SQLite.

const txColumns = `t.id, t.raw_hex, t.hash, t.first_seen, t.route_type, t.payload_type, t.decoded_json, t.observation_count, COALESCE(t.channel_hash,'')`

// obsColumns mirrors LoadAll: per-observation raw_hex is not loaded.
const obsColumns = `o.id, o.tx_id, o.observer_id, COALESCE(o.observer_name,''), COALESCE(o.observer_iata,''), o.rssi, o.snr, o.score, COALESCE(o.direction,''), COALESCE(o.path_json,'[]'), COALESCE(o.flood_scope,''), o.timestamp, ''`

// MaxIDs returns the highest transmission and observation ids (0 when empty).
func (d *DB) MaxIDs() (txID, obsID int64, err error) {
	err = d.db.QueryRow(`SELECT COALESCE((SELECT MAX(id) FROM transmissions), 0), COALESCE((SELECT MAX(id) FROM observations), 0)`).Scan(&txID, &obsID)
	return
}

// LoadWindow loads the hot window for server startup: every transmission from
// the oldest one first seen at/after cutoff (RFC3339) onwards — a contiguous id
// range — plus their observations, nodes and observers. It returns the window's
// first transmission id (maxTxID+1 when nothing is in the window).
func (d *DB) LoadWindow(cutoff string) (txs []*TxRow, obss []*ObsRow, nodes []*NodeRow, observers []*ObserverRow, firstTxID int64, err error) {
	var minID sql.NullInt64
	if err = d.db.QueryRow(`SELECT MIN(id) FROM transmissions WHERE first_seen >= ?`, cutoff).Scan(&minID); err != nil {
		return
	}
	if minID.Valid {
		firstTxID = minID.Int64
	} else {
		var maxTx int64
		if maxTx, _, err = d.MaxIDs(); err != nil {
			return
		}
		firstTxID = maxTx + 1
	}
	if txs, err = d.loadTxs(`SELECT `+txColumns+` FROM transmissions t WHERE t.id >= ? ORDER BY t.id ASC`, firstTxID); err != nil {
		return
	}
	if obss, err = d.loadObs(`SELECT `+obsColumns+` FROM observations o WHERE o.tx_id >= ? ORDER BY o.id ASC`, firstTxID); err != nil {
		return
	}
	if nodes, err = d.loadNodes(); err != nil {
		return
	}
	observers, err = d.loadObservers()
	return
}

// PacketByHash loads one transmission and its observations (nil when absent).
func (d *DB) PacketByHash(hash string) (*TxRow, []*ObsRow, error) {
	txs, err := d.loadTxs(`SELECT `+txColumns+` FROM transmissions t WHERE t.hash = ?`, hash)
	if err != nil || len(txs) == 0 {
		return nil, nil, err
	}
	obs, err := d.loadObs(`SELECT `+obsColumns+` FROM observations o WHERE o.tx_id = ? ORDER BY o.id ASC`, txs[0].ID)
	return txs[0], obs, err
}

// ObservationsFor loads the observations of the given transmissions.
func (d *DB) ObservationsFor(txIDs []int64) (map[int64][]*ObsRow, error) {
	out := make(map[int64][]*ObsRow, len(txIDs))
	if len(txIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(txIDs))
	for i, id := range txIDs {
		args[i] = id
	}
	obs, err := d.loadObs(`SELECT `+obsColumns+` FROM observations o WHERE o.tx_id IN (`+placeholders(len(txIDs))+`) ORDER BY o.id ASC`, args...)
	if err != nil {
		return nil, err
	}
	for _, o := range obs {
		out[o.TxID] = append(out[o.TxID], o)
	}
	return out, nil
}

// ArchiveQuery is the packet-list filter applied to rows older than the hot
// window. It mirrors store.PacketQuery's predicates.
type ArchiveQuery struct {
	Search       string // already lowercased + trimmed
	PayloadTypes []int
	RouteType    *int
	MinObs       int
	SinceISO     string // first_seen >= SinceISO when set
	Regions      []string
	Lock         bool
	ChannelHash  string // restrict to one channel's GRP_TXT messages when set
}

// where builds the SQL predicate (over alias t) and its args.
func (q ArchiveQuery) where(beforeID int64) (string, []any) {
	conds := []string{"t.id < ?"}
	args := []any{beforeID}
	if q.ChannelHash != "" {
		conds = append(conds, "t.channel_hash = ?")
		args = append(args, q.ChannelHash)
	}
	if len(q.PayloadTypes) > 0 {
		conds = append(conds, "t.payload_type IN ("+placeholders(len(q.PayloadTypes))+")")
		for _, pt := range q.PayloadTypes {
			args = append(args, pt)
		}
	}
	if q.RouteType != nil {
		conds = append(conds, "t.route_type = ?")
		args = append(args, *q.RouteType)
	}
	if q.MinObs > 1 {
		conds = append(conds, "t.observation_count >= ?")
		args = append(args, q.MinObs)
	}
	if q.SinceISO != "" {
		conds = append(conds, "t.first_seen >= ?")
		args = append(args, q.SinceISO)
	}
	if len(q.Regions) > 0 {
		in := placeholders(len(q.Regions))
		regionArgs := make([]any, len(q.Regions))
		for i, r := range q.Regions {
			regionArgs[i] = r
		}
		if q.Lock {
			// Heard only within the regions: at least one region-tagged
			// observation, and none tagged outside the set.
			conds = append(conds, "EXISTS (SELECT 1 FROM observations o WHERE o.tx_id = t.id AND COALESCE(o.observer_iata,'') <> '')",
				"NOT EXISTS (SELECT 1 FROM observations o WHERE o.tx_id = t.id AND COALESCE(o.observer_iata,'') <> '' AND o.observer_iata NOT IN ("+in+"))")
		} else {
			conds = append(conds, "EXISTS (SELECT 1 FROM observations o WHERE o.tx_id = t.id AND o.observer_iata IN ("+in+"))")
		}
		args = append(args, regionArgs...)
	}
	if q.Search != "" {
		like := "%" + escapeLike(q.Search) + "%"
		parts := []string{`LOWER(t.hash) LIKE ? ESCAPE '\'`}
		args = append(args, like)
		if isDigits(q.Search) {
			parts = append(parts, `CAST(t.id AS TEXT) LIKE ? ESCAPE '\'`)
			args = append(args, like)
		}
		for _, f := range []string{"name", "sender", "text", "pubKey", "channel", "type"} {
			parts = append(parts, `LOWER(json_extract(t.decoded_json, '$.`+f+`')) LIKE ? ESCAPE '\'`)
			args = append(args, like)
		}
		conds = append(conds, "("+strings.Join(parts, " OR ")+")")
	}
	return strings.Join(conds, " AND "), args
}

// OlderPackets returns transmissions with id < beforeID matching q, newest
// first, with their observations.
func (d *DB) OlderPackets(q ArchiveQuery, beforeID int64, limit, offset int) ([]*TxRow, map[int64][]*ObsRow, error) {
	if limit <= 0 {
		return nil, nil, nil
	}
	where, args := q.where(beforeID)
	args = append(args, limit, offset)
	txs, err := d.loadTxs(`SELECT `+txColumns+` FROM transmissions t WHERE `+where+` ORDER BY t.id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]int64, len(txs))
	for i, t := range txs {
		ids[i] = t.ID
	}
	obs, err := d.ObservationsFor(ids)
	return txs, obs, err
}

// CountOlderPackets counts transmissions with id < beforeID matching q.
func (d *DB) CountOlderPackets(q ArchiveQuery, beforeID int64) (int, error) {
	where, args := q.where(beforeID)
	var n int
	err := d.db.QueryRow(`SELECT COUNT(*) FROM transmissions t WHERE `+where, args...).Scan(&n)
	return n, err
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	_, err := strconv.ParseUint(s, 10, 64)
	return err == nil && !strings.ContainsAny(s, "+-")
}
