#!/bin/sh
set -e

PASSWD_FILE=/mosquitto/config/passwd

if [ -n "$MQTT_USERNAME" ] && [ -n "$MQTT_PASSWORD" ]; then
  mosquitto_passwd -c -b "$PASSWD_FILE" "$MQTT_USERNAME" "$MQTT_PASSWORD"
  echo "[mqtt] password file created for user: $MQTT_USERNAME"
else
  echo "[mqtt] MQTT_USERNAME / MQTT_PASSWORD not set — broker will reject all connections" >&2
  touch "$PASSWD_FILE"
fi

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
