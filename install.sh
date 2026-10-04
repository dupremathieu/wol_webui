#!/usr/bin/env bash
#
# Install the Wake-on-LAN Web UI as a systemd service.
#
# Usage:
#   sudo ./install.sh
#
# The service listens on 127.0.0.1 by default. Put a reverse proxy (nginx,
# Caddy, ...) with authentication in front of it if you need remote access.

set -euo pipefail

INSTALL_DIR="/opt/wol_webui"
SERVICE_NAME="wol-webui"
SERVICE_USER="wol-webui"
SERVICE_GROUP="wol-webui"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

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

NOLOGIN_SHELL="$(command -v nologin || true)"
if [[ -z "${NOLOGIN_SHELL}" ]]; then
  NOLOGIN_SHELL="/usr/sbin/nologin"
fi

echo "Installing ${SERVICE_NAME} from ${SRC_DIR} to ${INSTALL_DIR}..."

# Create the service account if needed.
if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${SERVICE_GROUP}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_GROUP}" --home-dir "${INSTALL_DIR}" \
    --shell "${NOLOGIN_SHELL}" "${SERVICE_USER}"
fi

# Copy the application files.
mkdir -p "${INSTALL_DIR}"
install -m 0644 "${SRC_DIR}/server.js" "${INSTALL_DIR}/server.js"
install -m 0644 "${SRC_DIR}/package.json" "${INSTALL_DIR}/package.json"
rm -rf "${INSTALL_DIR}/public"
cp -r "${SRC_DIR}/public" "${INSTALL_DIR}/public"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"

# Install the unit, rewriting the node path to match this system.
sed "s#^ExecStart=.*#ExecStart=${NODE_BIN_ESCAPED} ${INSTALL_DIR}/server.js#" \
  "${SRC_DIR}/${SERVICE_NAME}.service" > "${UNIT_PATH}"
chmod 0644 "${UNIT_PATH}"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo
echo "Done. Service status:"
systemctl --no-pager --full status "${SERVICE_NAME}" || true
echo
echo "Running on http://127.0.0.1:8080 (configure a reverse proxy for remote access)."
