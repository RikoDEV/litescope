package main

import (
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

	// Load everything into memory
	txs, obss, nodes, observers, err := database.LoadAll()
	if err != nil {
		log.Fatalf("load: %v", err)
	}
	st := store.New()
	st.Load(txs, obss, nodes, observers)
	lastTxID, lastObsID := st.LastIDs()
	log.Printf("loaded %d packets, %d observations, %d nodes, %d observers",
		len(txs), len(obss), len(nodes), len(observers))

	hub := api.NewHub()
	srv := api.NewServer(st, hub, cfg.ChannelKeys)

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
			added := st.AddTxBatch(newTxs, newObss)
			tid, oid := st.LastIDs()
			lastTxID, lastObsID = tid, oid

			// Reload nodes/observers periodically
			if len(newTxs) > 0 {
				nodeRows, _ := database.LoadNodeUpdates("")
				st.UpdateNodes(nodeRows)
				obsRows, _ := database.LoadObserverUpdates("")
				st.UpdateObservers(obsRows)
			}

			// Broadcast new packets over WebSocket
			for _, tx := range added {
				maxHops := 0
				hopSize := 0
				bestScope := ""
				var bestPath []string
				for _, o := range tx.Observations {
					var hops []string
					if json.Unmarshal([]byte(o.PathJSON), &hops) == nil && len(hops) > maxHops {
						maxHops = len(hops)
						bestPath = hops
						if len(hops) > 0 {
							hopSize = len(hops[0]) / 2
						}
					}
					if bestScope == "" && o.FloodScope != "" {
						bestScope = o.FloodScope
					}
				}
				data := map[string]interface{}{
					"id":          tx.ID,
					"hash":        tx.Hash,
					"firstSeen":   tx.FirstSeen,
					"routeType":   tx.RouteType,
					"payloadType": tx.PayloadType,
					"obsCount":    tx.ObsCount,
					"maxHops":     maxHops,
					"hopSize":     hopSize,
					"channelHash": tx.ChannelHash,
					"decoded":     tx.Decoded(),
				}
				if bestScope != "" {
					data["bestScope"] = bestScope
				}
				if len(bestPath) > 0 {
					data["bestPath"] = bestPath
				}
				msg, _ := json.Marshal(map[string]interface{}{"type": "packet", "data": data})
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
}

func init() {
	for _, arg := range os.Args[1:] {
		if arg == "--version" || arg == "-version" {
			fmt.Println("litescope-server dev")
			os.Exit(0)
		}
	}
}
