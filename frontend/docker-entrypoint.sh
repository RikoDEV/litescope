#!/bin/sh
set -e

# Write runtime env vars into env-config.js before nginx starts.
# The script tag in index.html loads this before the app bundle,
# so window.__ENV__ is available when import statements execute.
cat > /usr/share/nginx/html/env-config.js << EOF
window.__ENV__ = {
  VITE_API_URL:          "${VITE_API_URL:-}",
  VITE_SITE_URL:         "${VITE_SITE_URL:-}",
  VITE_UMAMI_URL:        "${VITE_UMAMI_URL:-}",
  VITE_UMAMI_WEBSITE_ID: "${VITE_UMAMI_WEBSITE_ID:-}",
  VITE_MQTT_HOST:        "${VITE_MQTT_HOST:-}",
  VITE_MQTT_USERNAME:    "${VITE_MQTT_USERNAME:-}",
  VITE_MQTT_PASSWORD:    "${VITE_MQTT_PASSWORD:-}"
};
EOF

SITE_URL="${VITE_SITE_URL:-${SITE_URL:-${CF_PAGES_URL:-}}}"
SITE_URL="${SITE_URL%/}"

if [ -n "$SITE_URL" ]; then
cat > /usr/share/nginx/html/robots.txt << EOF
User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
EOF

cat > /usr/share/nginx/html/sitemap.xml << EOF
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1</priority></url>
  <url><loc>${SITE_URL}/packets</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${SITE_URL}/map</loc><changefreq>daily</changefreq><priority>0.85</priority></url>
  <url><loc>${SITE_URL}/live</loc><changefreq>daily</changefreq><priority>0.85</priority></url>
  <url><loc>${SITE_URL}/nodes</loc><changefreq>daily</changefreq><priority>0.85</priority></url>
  <url><loc>${SITE_URL}/channels</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${SITE_URL}/observers</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${SITE_URL}/analytics</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${SITE_URL}/analytics/activity</loc><changefreq>daily</changefreq><priority>0.75</priority></url>
  <url><loc>${SITE_URL}/analytics/rf</loc><changefreq>daily</changefreq><priority>0.75</priority></url>
  <url><loc>${SITE_URL}/analytics/nodes</loc><changefreq>daily</changefreq><priority>0.75</priority></url>
  <url><loc>${SITE_URL}/analytics/observers</loc><changefreq>daily</changefreq><priority>0.75</priority></url>
  <url><loc>${SITE_URL}/analytics/channels</loc><changefreq>daily</changefreq><priority>0.75</priority></url>
  <url><loc>${SITE_URL}/analytics/hashes</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${SITE_URL}/analytics/scope</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${SITE_URL}/analytics/distance</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${SITE_URL}/decode</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
</urlset>
EOF
else
cat > /usr/share/nginx/html/robots.txt << EOF
User-agent: *
Allow: /
EOF
rm -f /usr/share/nginx/html/sitemap.xml
fi

exec nginx -g 'daemon off;'
