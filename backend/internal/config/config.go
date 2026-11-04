package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
)

type Config struct {
	Port           int               `json:"port"`
	DBPath         string            `json:"dbPath"`
	MQTTSources    []MQTTSource      `json:"mqttSources"`
	ChannelKeys    map[string]string `json:"channelKeys"`
	HashChannels   []string          `json:"hashChannels"`
	ScopeList      []string          `json:"scopeList"`
	// AllowedOrigins controls CORS and WebSocket origin checks. Empty or ["*"]
	// allows any origin (default, preserves prior behavior); otherwise only the
	// listed origins (e.g. "https://litescope.example") are accepted.
	AllowedOrigins []string `json:"allowedOrigins"`
	// RetentionDays bounds history: packets older than this are pruned from the
	// in-memory store (server) and the SQLite database (ingestor). 0 (default)
	// keeps everything — unbounded, fine for short-lived or low-volume setups, but
	// memory and per-request analytics cost grow with history on a busy network.
	RetentionDays int `json:"retentionDays"`
	// NodeRetentionDays purges nodes/observers whose last_seen is older than this
	// many days from the SQLite registry (and the in-memory store, on the next
	// periodic metadata refresh). 0 (default) keeps every node/observer ever
	// seen, even ones that have gone permanently silent. Independent of
	// RetentionDays, which only bounds packet/observation history — a node or
	// observer's row otherwise survives regardless of how old its packets are,
	// since advert_count/packet_count are lifetime cumulative totals.
	NodeRetentionDays int `json:"nodeRetentionDays"`
	// DisableLocationRepair turns off the observer-consensus fallback that fills
	// in or corrects node coordinates when the advertised GPS is missing or
	// implausible. Off (repair enabled) by default; set true to always trust
	// advertised coordinates as-is, even when absent.
	DisableLocationRepair bool `json:"disableLocationRepair"`
	// AnalyticsCacheTTLSeconds is how long a computed analytics result counts as
	// fresh while new packets keep arriving (default 30). Past it the previous
	// result is still served while one background recompute runs.
	AnalyticsCacheTTLSeconds int `json:"analyticsCacheTTLSeconds"`
	// DebugListen, when set (e.g. "127.0.0.1:6060"), serves net/http/pprof on
	// that address from the server process for CPU/heap profiling. Off by
	// default; bind it to loopback — it is unauthenticated.
	DebugListen string `json:"debugListen"`
	// Wardrive configures the optional MeshMapper "Custom API" endpoint that
	// collects GPS-tagged coverage pings for the /map coverage layer.
	Wardrive Wardrive `json:"wardrive"`
}

// Wardrive configures coverage-ping ingestion (issue #114). The ingestor hosts
// the HTTP endpoint (it is the only DB writer); the server reads and aggregates.
type Wardrive struct {
	// Enabled registers the endpoint. Off by default.
	Enabled bool `json:"enabled"`
	// Listen is the ingestor's HTTP listen address for POST /api/wardrive.
	Listen string `json:"listen"`
	// IngestorURL is where the server forwards POST /api/wardrive (so existing
	// reverse-proxy setups that route /api/* to the server need no change).
	// Defaults to http://127.0.0.1:<Listen port> (both run in one container).
	IngestorURL string `json:"ingestorURL"`
	// SharedKey, when non-empty, must match the X-API-Key header. It is an
	// instance-wide key (not a user login); empty accepts any key.
	SharedKey string `json:"sharedKey"`
	// MaxPingAgeHours rejects pings with a timestamp older than this.
	MaxPingAgeHours int `json:"maxPingAgeHours"`
	// MaxRepeaterDistanceKm drops a "heard" entry whose repeater is known to be
	// farther than this from the ping location.
	MaxRepeaterDistanceKm float64 `json:"maxRepeaterDistanceKm"`
	// MinDevicesPerCell hides coverage cells confirmed by fewer distinct devices.
	MinDevicesPerCell int `json:"minDevicesPerCell"`
	// TrustedProxies are CIDRs whose X-Forwarded-For / CF-Connecting-IP headers
	// are trusted when resolving the client IP for rate limiting.
	TrustedProxies []string `json:"trustedProxies"`
}

type MQTTSource struct {
	Name     string   `json:"name"`
	Broker   string   `json:"broker"`
	Username string   `json:"username"`
	Password string   `json:"password"`
	Topics   []string `json:"topics"`
	Region   string   `json:"region"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Port == 0 {
		cfg.Port = 3000
	}
	if cfg.DBPath == "" {
		cfg.DBPath = "litescope.db"
	}
	if cfg.ChannelKeys == nil {
		cfg.ChannelKeys = make(map[string]string)
	}
	if cfg.ScopeList == nil {
		cfg.ScopeList = []string{}
	}
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = []string{"*"}
	}
	if cfg.Wardrive.Listen == ""                { cfg.Wardrive.Listen = ":3001" }
	if cfg.Wardrive.IngestorURL == "" {
		port := cfg.Wardrive.Listen
		if i := strings.LastIndex(port, ":"); i >= 0 {
			port = port[i+1:]
		}
		cfg.Wardrive.IngestorURL = "http://127.0.0.1:" + port
	}
	if cfg.Wardrive.MaxPingAgeHours <= 0        { cfg.Wardrive.MaxPingAgeHours = 72 }
	if cfg.Wardrive.MaxRepeaterDistanceKm <= 0  { cfg.Wardrive.MaxRepeaterDistanceKm = 150 }
	if cfg.Wardrive.MinDevicesPerCell <= 0      { cfg.Wardrive.MinDevicesPerCell = 1 }
	if cfg.Wardrive.TrustedProxies == nil {
		cfg.Wardrive.TrustedProxies = []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}
	}
	// Built-in public channel key from MeshCore firmware defaults
	if _, ok := cfg.ChannelKeys["Public"]; !ok {
		cfg.ChannelKeys["Public"] = "8b3387e9c5cdea6ac9e5edbaa115cd72"
	}
	// Derive AES keys for hashtag channels via SHA256(name)[:16]
	for _, ch := range cfg.HashChannels {
		if ch == "" {
			continue
		}
		if ch[0] != '#' {
			ch = "#" + ch
		}
		if _, ok := cfg.ChannelKeys[ch]; !ok {
			h := sha256.Sum256([]byte(ch))
			cfg.ChannelKeys[ch] = hex.EncodeToString(h[:16])
		}
	}
	return &cfg, nil
}
