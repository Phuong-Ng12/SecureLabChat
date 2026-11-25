#!/usr/bin/env bash
# Tested with Git Bash on Windows. Mac needs a version without -addext.
# Makes a self-signed certificate and private key for the LAN host.
# Usage:  ./scripts/generate-cert.sh <lan-ip> [hostname] (hostname is optional)
# Example: ./scripts/generate-cert.sh 192.168.1.50 securelabchat.local
set -euo pipefail

export MSYS_NO_PATHCONV=1

LAN_IP="${1:?Usage: $0 <lan-ip> [hostname]}"
HOST_NAME="${2:-}"

# Work from the project folder and use relative paths.
cd "$(dirname "$0")/.."
CERT_DIR="certs"
mkdir -p "$CERT_DIR"

# The browser only accepts the certificate when the address people type is in this list
SAN="DNS:localhost,IP:127.0.0.1,IP:${LAN_IP}"
if [ -n "$HOST_NAME" ]; then
    SAN="${SAN},DNS:${HOST_NAME}"
fi

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -subj "/CN=SecureLabChat" \
    -addext "subjectAltName=${SAN}"

chmod 600 "$CERT_DIR/server.key"
echo "Created $(pwd)/$CERT_DIR/server.key and server.crt (valid for: ${SAN})"