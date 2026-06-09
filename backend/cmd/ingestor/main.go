package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/litescope/backend/internal/config"
	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/decoder"
	"github.com/litescope/backend/internal/version"
)

func main() {
	cfgPath := flag.String("config", "config.json", "path to config file")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[ingestor] ")

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	database, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer database.Close()
	log.Printf("SQLite opened: %s", cfg.DBPath)

	channelKeys := cfg.ChannelKeys
	if len(channelKeys) == 0 {
		log.Printf("no channel keys configured — GRP_TXT will not be decrypted")
	} else {
		log.Printf("loaded %d channel keys", len(channelKeys))
		redecodeExisting(database, channelKeys)
	}

	if len(cfg.MQTTSources) == 0 {
		log.Fatal("no mqttSources configured")
	}

	// Bound database growth: prune transmissions/observations past the retention
	// window. The ingestor owns DB writes, so it owns DB retention.
	if cfg.RetentionDays > 0 {
		prune := func() {
			cutoff := time.Now().UTC().Add(-time.Duration(cfg.RetentionDays) * 24 * time.Hour).Format(time.RFC3339)
			if n, err := database.PruneOlderThan(cutoff); err != nil {
				log.Printf("prune: %v", err)
			} else if n > 0 {
				log.Printf("pruned %d transmissions older than %d day(s)", n, cfg.RetentionDays)
			}
		}
		prune()
		go func() {
			ticker := time.NewTicker(time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				prune()
			}
		}()
	}

	var clients []mqtt.Client
	connected := 0
	for _, src := range cfg.MQTTSources {
		tag := src.Name
		if tag == "" {
			tag = src.Broker
		}
		opts := buildOpts(src)
		opts.SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("[%s] connected", tag)
			topics := src.Topics
			if len(topics) == 0 {
				topics = []string{"meshcore/#"}
			}
			for _, t := range topics {
				tok := c.Subscribe(t, 0, nil)
				tok.Wait()
				if tok.Error() != nil {
					log.Printf("[%s] subscribe %s: %v", tag, t, tok.Error())
				} else {
					log.Printf("[%s] subscribed to %s", tag, t)
				}
			}
		})
		opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Printf("[%s] disconnected: %v", tag, err)
		})
		capSrc := src
		opts.SetDefaultPublishHandler(func(_ mqtt.Client, m mqtt.Message) {
			handleMsg(database, tag, capSrc, m, channelKeys, cfg.ScopeList)
		})
		c := mqtt.NewClient(opts)
		if !c.Connect().WaitTimeout(30 * time.Second) {
			log.Printf("[%s] connect timed out — retrying in background", tag)
		} else {
			connected++
		}
		clients = append(clients, c)
	}
	if connected == 0 && len(clients) == 0 {
		log.Fatal("no MQTT sources connected")
	}
	log.Printf("running — %d source(s) connected", connected)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down")
	for _, c := range clients {
		c.Disconnect(2000)
	}
}

func buildOpts(src config.MQTTSource) *mqtt.ClientOptions {
	opts := mqtt.NewClientOptions().
		AddBroker(src.Broker).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetMaxReconnectInterval(30 * time.Second).
		SetKeepAlive(30 * time.Second)
	if src.Username != "" {
		opts.SetUsername(src.Username)
	}
	if src.Password != "" {
		opts.SetPassword(src.Password)
	}
	if u, err := url.Parse(src.Broker); err == nil {
		if u.Scheme == "ssl" || u.Scheme == "wss" {
			opts.SetTLSConfig(&tls.Config{})
		}
	}
	return opts
}

func handleMsg(database *db.DB, tag string, src config.MQTTSource, m mqtt.Message, channelKeys map[string]string, scopeList []string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] panic: %v", tag, r)
		}
	}()

	topic := m.Topic()
	parts := strings.Split(topic, "/")

	var msg map[string]any
	if err := json.Unmarshal(m.Payload(), &msg); err != nil {
		return
	}
	if topic == "meshcore/status" || topic == "meshcore/events/connection" {
		return
	}

	// Status message: meshcore/<region>/<id>/status
	if len(parts) >= 4 && parts[3] == "status" {
		obsID := parts[2]
		name, _ := msg["origin"].(string)
		iata := normalizeRegion(parts[1])
		meta := extractObsMeta(msg)
		now := time.Now().UTC().Format(time.RFC3339)
		if err := database.UpsertObserver(obsID, name, iata, now, meta); err != nil {
			log.Printf("[%s] observer status: %v", tag, err)
		}
		return
	}

	// Packet message: meshcore/<region>/<id>/...  with "raw" field
	rawHex, _ := msg["raw"].(string)
	if rawHex == "" {
		return
	}

	observerID := ""
	region := normalizeRegion(src.Region)
	if len(parts) > 2 {
		observerID = parts[2]
	}
	if len(parts) > 1 {
		if topicRegion := normalizeRegion(parts[1]); topicRegion != "" {
			region = topicRegion
		}
	}

	dec, err := decoder.DecodePacket(rawHex, channelKeys)
	if err != nil {
		log.Printf("[%s] decode error: %v (len=%d)", tag, err, len(rawHex))
		return
	}

	now := resolveRxTime(msg)
	hash := decoder.ComputeContentHash(rawHex)

	txRow := &db.TxRow{
		RawHex:      rawHex,
		Hash:        hash,
		FirstSeen:   now,
		RouteType:   dec.Header.RouteType,
		PayloadType: dec.Header.PayloadType,
		DecodedJSON: decoder.PayloadJSON(&dec.Payload),
	}
	if dec.Payload.ChannelHashHex != "" {
		txRow.ChannelHash = dec.Payload.ChannelHashHex
	}

	pathJSON := "[]"
	if len(dec.Path.Hops) > 0 {
		if b, err := json.Marshal(dec.Path.Hops); err == nil {
			pathJSON = string(b)
		}
	}
	obsRow := &db.ObsRow{
		ObserverID:   observerID,
		ObserverName: strField(msg, "origin"),
		ObserverIATA: region,
		Direction:    strField(msg, "direction", "Direction"),
		PathJSON:     pathJSON,
		FloodScope:   dec.ResolveFloodScope(scopeList),
		Timestamp:    now,
		RawHex:       rawHex,
	}
	if v, ok := toFloat64(msg["SNR"]); ok {
		obsRow.SNR = &v
	} else if v, ok := toFloat64(msg["snr"]); ok {
		obsRow.SNR = &v
	}
	if v, ok := toFloat64(msg["RSSI"]); ok {
		obsRow.RSSI = &v
	} else if v, ok := toFloat64(msg["rssi"]); ok {
		obsRow.RSSI = &v
	}
	if v, ok := toFloat64(msg["score"]); ok {
		obsRow.Score = &v
	}

	txID, _, err := database.InsertTransmission(txRow, obsRow)
	if err != nil {
		log.Printf("[%s] db insert: %v", tag, err)
		return
	}
	_ = txID

	// Upsert node from ADVERT
	if dec.Header.PayloadType == decoder.PayloadADVERT {
		ok, reason := decoder.ValidateAdvert(&dec.Payload)
		if !ok {
			log.Printf("[%s] invalid advert: %s", tag, reason)
			return
		}
		nodeRow := &db.NodeRow{
			PubKey:   dec.Payload.PubKey,
			Name:     dec.Payload.Name,
			Role:     decoder.AdvertRole(dec.Payload.Flags),
			Lat:      dec.Payload.Lat,
			Lon:      dec.Payload.Lon,
			LastSeen: now,
		}
		if err := database.UpsertNode(nodeRow); err != nil {
			log.Printf("[%s] node upsert: %v", tag, err)
		}
		if dec.Payload.BatteryMv != nil || dec.Payload.TemperatureC != nil {
			database.UpdateNodeTelemetry(dec.Payload.PubKey, dec.Payload.BatteryMv, dec.Payload.TemperatureC)
		}
	}

	// Upsert observer
	if observerID != "" {
		origin := strField(msg, "origin")
		now2 := time.Now().UTC().Format(time.RFC3339)
		database.UpsertObserver(observerID, origin, region, now2, nil)
	}
}

func redecodeExisting(database *db.DB, channelKeys map[string]string) {
	rows, err := database.UndecryptedChannelMessages()
	if err != nil {
		log.Printf("redecode: query failed: %v", err)
		return
	}
	if len(rows) == 0 {
		return
	}
	updated := 0
	for _, row := range rows {
		dec, err := decoder.DecodePacket(row.RawHex, channelKeys)
		if err != nil {
			continue
		}
		if dec.Payload.DecryptionStatus != "decrypted" {
			continue
		}
		j := decoder.PayloadJSON(&dec.Payload)
		if err := database.UpdateDecodedJSON(row.ID, j); err != nil {
			log.Printf("redecode: update %d: %v", row.ID, err)
			continue
		}
		updated++
	}
	if updated > 0 {
		log.Printf("redecode: updated %d/%d previously undecrypted GRP_TXT packets", updated, len(rows))
	}
}

func resolveRxTime(msg map[string]any) string {
	now := time.Now().UTC()
	raw, _ := msg["timestamp"].(string)
	if raw == "" {
		return now.Format(time.RFC3339)
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.999999", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			// Reject implausible timestamps (future, or older than 30 days) and fall
			// back to receive time.
			if t.After(now) || t.Before(now.Add(-30*24*time.Hour)) {
				return now.Format(time.RFC3339)
			}
			return t.UTC().Format(time.RFC3339)
		}
	}
	return now.Format(time.RFC3339)
}

func extractObsMeta(msg map[string]any) *db.ObserverMeta {
	meta := &db.ObserverMeta{}
	found := false

	// stats fields may live at the top level or nested inside "stats": {}
	// (observer publishes them inside stats dict)
	statsMap, _ := msg["stats"].(map[string]any)
	lookup := func(key string) (any, bool) {
		if v, ok := msg[key]; ok {
			return v, true
		}
		if statsMap != nil {
			if v, ok := statsMap[key]; ok {
				return v, true
			}
		}
		return nil, false
	}

	if v, ok := msg["model"].(string); ok && v != "" {
		meta.Model = &v
		found = true
	}
	// observer sends "firmware_version"; fall back to "firmware"
	for _, key := range []string{"firmware_version", "firmware"} {
		if v, ok := msg[key].(string); ok && v != "" {
			meta.Firmware = &v
			found = true
			break
		}
	}
	if v, ok := lookup("battery_mv"); ok {
		if f, ok2 := toFloat64(v); ok2 {
			iv := int(f)
			meta.BatteryMv = &iv
			found = true
		}
	}
	if v, ok := lookup("uptime_secs"); ok {
		if f, ok2 := toFloat64(v); ok2 {
			iv := int64(f)
			meta.UptimeSecs = &iv
			found = true
		}
	}
	if v, ok := lookup("noise_floor"); ok {
		if f, ok2 := toFloat64(v); ok2 {
			meta.NoiseFloor = &f
			found = true
		}
	}
	if !found {
		return nil
	}
	return meta
}

func strField(msg map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := msg[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func normalizeRegion(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 3 {
		return ""
	}
	for _, c := range s {
		if c < 'A' || c > 'Z' {
			return ""
		}
	}
	return s
}

func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		// observer serialises SNR/RSSI/score as str()
		s := strings.TrimSpace(n)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func init() {
	// Suppress paho's default logging
	mqtt.ERROR = log.New(os.Stderr, "[mqtt:error] ", 0)
	mqtt.CRITICAL = log.New(os.Stderr, "[mqtt:crit] ", 0)
	mqtt.WARN = log.New(os.Stderr, "[mqtt:warn] ", 0)
	if os.Getenv("MQTT_DEBUG") == "1" {
		mqtt.DEBUG = log.New(os.Stdout, "[mqtt:debug] ", 0)
	}
	for _, arg := range os.Args[1:] {
		if arg == "--version" || arg == "-version" {
			fmt.Println("litescope-ingestor " + version.Version)
			os.Exit(0)
		}
	}
}
