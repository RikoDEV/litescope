// Package version is the single source of truth for the backend build version.
// It defaults to "dev" and is overridden at build time via:
//
//	go build -ldflags "-X github.com/litescope/backend/internal/version.Version=1.2.3"
package version

// Version is the running build version. Both the server and ingestor binaries
// report it via their --version flag.
var Version = "dev"
