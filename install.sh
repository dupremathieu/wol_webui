#!/usr/bin/env bash
#
# Install the Wake-on-LAN Web UI as a systemd service.
#
# Usage:
#   sudo ./install.sh
#   sudo PORT=8090 ./install.sh
#
# The service runs under systemd DynamicUser=yes: no static system account is
# created. Persistent data (devices.json) lives in /var/lib/wol-webui via
# StateDirectory=. The application code is installed root-owned in
# /opt/wol_webui and is read-only to the service.
#
# The service listens on 127.0.0.1 by default; put a reverse proxy (nginx,
# Caddy, ...) with authentication in front of it for remote access.

set -euo pipefail

INSTALL_DIR="/opt/wol_webui"
SERVICE_NAME="wol-webui"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
CONF_FILE="/etc/wol-webui.conf"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must be run as root (use sudo)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_BIN_ESCAPED="${NODE_BIN//&/\\&}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing ${SERVICE_NAME} from ${SRC_DIR} to ${INSTALL_DIR}..."

# Copy the application files (owned by root; the DynamicUser only reads them).
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 0644 "${SRC_DIR}/server.js" "${INSTALL_DIR}/server.js"
install -m 0644 "${SRC_DIR}/package.json" "${INSTALL_DIR}/package.json"
cp -r "${SRC_DIR}/public" "${INSTALL_DIR}/public"

# Optional: persist a custom port through the drop-in environment file.
if [[ -n "${PORT:-}" ]]; then
  echo "PORT=${PORT}" > "${CONF_FILE}"
  chmod 0644 "${CONF_FILE}"
  echo "Wrote ${CONF_FILE} with PORT=${PORT}"
fi

# Install the unit, rewriting the node path to match this system.
sed "s#^ExecStart=.*#ExecStart=${NODE_BIN_ESCAPED} ${INSTALL_DIR}/server.js#" \
  "${SRC_DIR}/${SERVICE_NAME}.service" > "${UNIT_PATH}"
chmod 0644 "${UNIT_PATH}"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo
echo "Done. Service status:"
systemctl --no-pager --full status "${SERVICE_NAME}" || true
