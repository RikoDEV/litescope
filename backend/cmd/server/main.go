package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/litescope/backend/internal/api"
	"github.com/litescope/backend/internal/config"
	"github.com/litescope/backend/internal/db"
	"github.com/litescope/backend/internal/store"
	"github.com/litescope/backend/internal/version"
)

func main() {
	cfgPath := flag.String("config", "config.json", "path to config file")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[server] ")

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

	pruneDatabaseRetention(database, cfg.RetentionDays, "startup")

	// Load everything into memory
	loadStart := time.Now()
	txs, obss, nodes, observers, err := database.LoadAll()
	if err != nil {
		log.Fatalf("load: %v", err)
	}
	dbLoadDur := time.Since(loadStart)
	indexStart := time.Now()
	st := store.New()
	st.SetLocationRepairEnabled(!cfg.DisableLocationRepair)
	st.Load(txs, obss, nodes, observers)
	indexDur := time.Since(indexStart)
	lastTxID, lastObsID := st.LastIDs()
	log.Printf("loaded %d packets, %d observations, %d nodes, %d observers (db=%s, index=%s)",
		len(txs), len(obss), len(nodes), len(observers), dbLoadDur.Round(time.Millisecond), indexDur.Round(time.Millisecond))
	if cfg.DisableLocationRepair {
		log.Printf("location repair disabled via config (disableLocationRepair=true)")
	} else {
		logLocationRepair("startup", st.LastLocationRepairStats())
	}

	hub := api.NewHub(cfg.AllowedOrigins)
	srv := api.NewServer(st, hub, cfg.ChannelKeys, cfg.AllowedOrigins)

	// Refresh node/observer metadata on a slower cadence — these tables are
	// reloaded wholesale, so doing it every packet tick was wasteful.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			nodeLoadStart := time.Now()
			nodeRows, err := database.LoadNodeUpdates()
			nodeLoadDur := time.Since(nodeLoadStart)
			if err != nil {
				log.Printf("node refresh: %v", err)
			} else {
				nodeUpdateStart := time.Now()
				repairStats := st.UpdateNodes(nodeRows)
				nodeUpdateDur := time.Since(nodeUpdateStart)
				if repairStats.Duration > 0 {
					log.Printf("node refresh: rows=%d db=%s update=%s",
						len(nodeRows), nodeLoadDur.Round(time.Millisecond), nodeUpdateDur.Round(time.Millisecond))
					logLocationRepair("node refresh", repairStats)
				}
			}

			obsRows, err := database.LoadObserverUpdates()
			if err != nil {
				log.Printf("observer refresh: %v", err)
			} else {
				st.UpdateObservers(obsRows)
			}
		}
	}()

	// Bound in-memory growth: drop packets older than the retention window.
	if cfg.RetentionDays > 0 {
		prune := func() {
			cutoff := time.Now().UTC().Add(-time.Duration(cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
			if n := st.Prune(cutoff); n > 0 {
				log.Printf("pruned %d packets older than %d day(s) from memory", n, cfg.RetentionDays)
			}
		}
		prune() // once at startup so a large reloaded history is trimmed immediately
		go func() {
			ticker := time.NewTicker(time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				prune()
			}
		}()
	}

	// Poll SQLite for new packets every second
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			newTxs, newObss, err := database.LoadSince(lastTxID, lastObsID)
			if err != nil {
				log.Printf("poll error: %v", err)
				continue
			}
			if len(newTxs) == 0 && len(newObss) == 0 {
				continue
			}
			added, updated := st.AddTxBatch(newTxs, newObss)
			tid, oid := st.LastIDs()
			lastTxID, lastObsID = tid, oid

			// Broadcast new packets over WebSocket
			for _, tx := range added {
				b := tx.BestObservation()
				// Report unique observers (matches the REST summary); fall back to
				// the DB count only when no observations loaded with this packet.
				obsCount := b.UniqueObs
				if obsCount == 0 {
					obsCount = tx.ObsCount
				}
				data := map[string]any{
					"id":          tx.ID,
					"hash":        tx.Hash,
					"firstSeen":   tx.FirstSeen,
					"routeType":   tx.RouteType,
					"payloadType": tx.PayloadType,
					"obsCount":    obsCount,
					"maxHops":     b.MaxHops,
					"hopSize":     b.HopSize,
					"channelHash": tx.ChannelHash,
					"decoded":     tx.Decoded(),
				}
				if b.BestScope != "" {
					data["bestScope"] = b.BestScope
				}
				if len(b.BestPath) > 0 {
					data["bestPath"] = b.BestPath
				}
				if b.BestObserver != "" {
					data["bestObserver"] = b.BestObserver
				}
				if len(b.Regions) > 0 {
					data["regions"] = b.Regions
				}
				if dec := tx.Decoded(); dec != nil {
					if pubKey, _ := dec["pubKey"].(string); pubKey != "" {
						if n := st.NodeByPubKey(pubKey); n != nil {
							if n.Lat != nil && n.Lon != nil {
								data["nodeLat"] = *n.Lat
								data["nodeLon"] = *n.Lon
							}
							if n.Country != "" {
								data["country"] = n.Country
							}
						}
					}
				}
				msg, _ := json.Marshal(map[string]any{"type": "packet", "data": data})
				hub.Broadcast(msg)
			}

			// Broadcast count updates for already-seen packets that gained
			// observations, so the UI can show propagation building up live.
			for _, tx := range updated {
				b := tx.BestObservation()
				data := map[string]any{
					"id":       tx.ID,
					"hash":     tx.Hash,
					"obsCount": b.UniqueObs,
					"maxHops":  b.MaxHops,
					"hopSize":  b.HopSize,
				}
				if b.BestScope != "" {
					data["bestScope"] = b.BestScope
				}
				if len(b.BestPath) > 0 {
					data["bestPath"] = b.BestPath
				}
				if b.BestObserver != "" {
					data["bestObserver"] = b.BestObserver
				}
				if len(b.Regions) > 0 {
					data["regions"] = b.Regions
				}
				msg, _ := json.Marshal(map[string]any{"type": "packetUpdate", "data": data})
				hub.Broadcast(msg)
			}
		}
	}()

	addr := fmt.Sprintf(":%d", cfg.Port)
	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      srv.Router(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
	}
	go func() {
		log.Printf("listening on %s", addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func pruneDatabaseRetention(database *db.DB, retentionDays int, label string) {
	if retentionDays <= 0 {
		return
	}
	start := time.Now()
	cutoff := time.Now().UTC().Add(-time.Duration(retentionDays) * 24 * time.Hour).Format(time.RFC3339)
	n, err := database.PruneOlderThan(cutoff)
	if err != nil {
		log.Printf("%s DB retention prune: %v", label, err)
		return
	}
	log.Printf("%s DB retention prune: pruned %d transmissions older than %d day(s) (duration=%s)",
		label, n, retentionDays, time.Since(start).Round(time.Millisecond))
}

func logLocationRepair(prefix string, stats store.LocationRepairStats) {
	log.Printf("%s location repair: checked=%d observerNodes=%d consensus=%d repairedMissing=%d repairedSuspicious=%d changed=%d duration=%s",
		prefix,
		stats.Checked,
		stats.ObserverNodes,
		stats.WithConsensus,
		stats.RepairedMissing,
		stats.RepairedSuspicious,
		stats.Changed,
		stats.Duration.Round(time.Millisecond),
	)
}

func init() {
	for _, arg := range os.Args[1:] {
		if arg == "--version" || arg == "-version" {
			fmt.Println("litescope-server " + version.Version)
			os.Exit(0)
		}
	}
}
