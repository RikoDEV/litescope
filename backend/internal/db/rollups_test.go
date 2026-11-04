package db

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)


// rollupFixture writes a varied batch: duplicate deliveries of one packet from
// several observers, SNR values at and beyond the histogram edges, missing
// RF values, decrypted / undecryptable channel messages and adverts heard in
// several regions.
func rollupFixture(t *testing.T, d *DB) {
	t.Helper()
	var items []*WriteItem
	add := func(hash, firstSeen string, pt int, dec, ch string, obsID, iata, ts string, snr, rssi *float64) {
		items = append(items, &WriteItem{
			Tx:  &TxRow{RawHex: "00", Hash: hash, FirstSeen: firstSeen, PayloadType: pt, DecodedJSON: dec, ChannelHash: ch},
			Obs: &ObsRow{ObserverID: obsID, ObserverIATA: iata, PathJSON: "[]", Timestamp: ts, SNR: snr, RSSI: rssi},
		})
	}
	advert := `{"type":"ADVERT","pubKey":"aa11"}`
	add("a1", "2026-03-01T10:15:00Z", 4, advert, "", "o1", "WAW", "2026-03-01T10:15:00Z", f64(-30), f64(-120))
	add("a1", "2026-03-01T10:15:00Z", 4, advert, "", "o2", "KRK", "2026-03-01T10:16:00Z", f64(14.9), nil)
	add("a1", "2026-03-01T10:15:00Z", 4, advert, "", "o2", "KRK", "2026-03-01T11:01:00Z", f64(15), f64(-60)) // dup delivery, next hour
	add("c1", "2026-03-01T10:20:00Z", 5, `{"type":"GRP_TXT","decryptionStatus":"decrypted","channel":"Public"}`, "11", "o1", "WAW", "2026-03-01T10:20:00Z", f64(-25), f64(-90))
	add("c2", "2026-03-01T12:00:00Z", 5, `{"type":"GRP_TXT","decryptionStatus":"no_key"}`, "11", "o3", "", "2026-03-01T12:00:00Z", nil, nil)
	add("c3", "2026-03-02T00:00:00Z", 5, `{"type":"GRP_TXT","decryptionStatus":"no_key"}`, "22", "o3", "", "2026-03-02T00:00:00Z", f64(-21), nil)
	for i := range 12 {
		snr := float64(-27 + i*4)
		add(fmt.Sprintf("t%d", i), "2026-03-02T05:00:00Z", 2, `{"type":"TXT_MSG"}`, "", "o4", "GDN", "2026-03-02T05:30:00Z", &snr, f64(float64(-100+i)))
	}
	if err := d.WriteBatch(items); err != nil {
		t.Fatalf("WriteBatch: %v", err)
	}
}

func dumpRollups(t *testing.T, d *DB) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	for _, table := range []string{"rollup_tx_hourly", "rollup_obs_hourly", "rollup_channels", "rollup_node_regions"} {
		rows, err := d.db.Query(`SELECT * FROM ` + table + ` ORDER BY 1, 2, 3`)
		if err != nil {
			t.Fatalf("%s: %v", table, err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			parts := make([]string, len(vals))
			for i, v := range vals {
				switch x := v.(type) {
				case float64:
					parts[i] = fmt.Sprintf("%.6g", x)
				default:
					parts[i] = fmt.Sprint(x)
				}
			}
			out[table] = append(out[table], strings.Join(parts, "|"))
		}
		rows.Close()
	}
	return out
}

// TestRollupIncrementalMatchesBackfill: what WriteBatch maintains row by row
// must equal what migration 00005's backfill computes from the same rows.
func TestRollupIncrementalMatchesBackfill(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatalf("OpenAndMigrate: %v", err)
	}
	defer d.Close()
	rollupFixture(t, d)
	incremental := dumpRollups(t, d)

	sqlText, err := os.ReadFile("migrations/sqlite/00005_rollups.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	backfill := sqlText[strings.Index(string(sqlText), "-- ── Backfill"):]
	for _, table := range []string{"rollup_tx_hourly", "rollup_obs_hourly", "rollup_channels", "rollup_node_regions"} {
		if _, err := d.db.Exec(`DELETE FROM ` + table); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.db.Exec(string(backfill)); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if got := dumpRollups(t, d); !reflect.DeepEqual(got, incremental) {
		t.Fatalf("backfill differs from incremental rollups:\nincremental %v\nbackfill    %v", incremental, got)
	}

	// Spot-check the semantics.
	byType, _ := d.RollupTxByType()
	if byType[4] != 1 || byType[5] != 3 || byType[2] != 12 {
		t.Fatalf("tx by type = %v", byType)
	}
	obs, snr, rssi, _ := d.RollupRF()
	if obs != 18 || snr.N != 17 || snr.Min != -30 || snr.Max != 17 || rssi.N != 15 {
		t.Fatalf("rf: obs=%d snr=%+v rssi=%+v", obs, snr, rssi)
	}
	chans, _ := d.RollupChannels()
	if len(chans) != 2 || chans[0].Hash != "11" || chans[0].Total != 2 || chans[0].Decrypted != 1 || chans[0].Name != "Public" {
		t.Fatalf("channels = %+v", chans)
	}
	regions, _ := d.RollupNodeRegions()
	if !reflect.DeepEqual(regions["aa11"], []string{"KRK", "WAW"}) {
		t.Fatalf("node regions = %v", regions)
	}
	o4, _ := d.RollupObserver("o4", 0)
	// -27..17 step 4 → bins: -27,-23 → 0,0; -19 → 1; … 13 → 9; 17 → 9 (clamped).
	if o4.SNRHist != [SNRHistBins]int64{2, 1, 1, 1, 1, 1, 1, 1, 1, 2} || o4.ByType[2] != 12 {
		t.Fatalf("observer o4 rollup = %+v", o4)
	}
}

func TestMarkChannelDecrypted(t *testing.T) {
	d, err := OpenAndMigrate(tempDBPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	rollupFixture(t, d)
	if err := d.MarkChannelDecrypted("22", "Secret"); err != nil {
		t.Fatal(err)
	}
	chans, _ := d.RollupChannels()
	if chans[1].Hash != "22" || chans[1].Decrypted != 1 || chans[1].Name != "Secret" {
		t.Fatalf("channel 22 = %+v", chans[1])
	}
}
