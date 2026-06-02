package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
)

type Config struct {
	Port           int               `json:"port"`
	DBPath         string            `json:"dbPath"`
	MQTTSources    []MQTTSource      `json:"mqttSources"`
	ChannelKeys    map[string]string `json:"channelKeys"`
	HashChannels   []string          `json:"hashChannels"`
	ScopeList []string          `json:"scopeList"`
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
