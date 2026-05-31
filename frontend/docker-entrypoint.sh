#!/bin/sh
set -e

# Write runtime env vars into env-config.js before nginx starts.
# The script tag in index.html loads this before the app bundle,
# so window.__ENV__ is available when import statements execute.
cat > /usr/share/nginx/html/env-config.js << EOF
window.__ENV__ = {
  VITE_API_URL:          "${VITE_API_URL:-}",
  VITE_UMAMI_URL:        "${VITE_UMAMI_URL:-}",
  VITE_UMAMI_WEBSITE_ID: "${VITE_UMAMI_WEBSITE_ID:-}",
  VITE_MQTT_HOST:        "${VITE_MQTT_HOST:-}",
  VITE_MQTT_USERNAME:    "${VITE_MQTT_USERNAME:-}",
  VITE_MQTT_PASSWORD:    "${VITE_MQTT_PASSWORD:-}"
};
EOF

exec nginx -g 'daemon off;'
