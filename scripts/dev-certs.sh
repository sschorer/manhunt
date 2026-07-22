#!/usr/bin/env bash
# Generate a locally-trusted TLS cert for the dev client so GPS works from other
# devices on your LAN (the Geolocation API needs a secure context, and phones
# won't let you click past an untrusted self-signed cert).
#
# It uses mkcert: a small tool that runs its own local CA. Installing that CA's
# root once per device makes the cert trusted with NO browser warning.
#
# Usage:
#   scripts/dev-certs.sh                 # auto-detect this host's LAN IP
#   scripts/dev-certs.sh 192.168.1.42    # or pass the IP/hostname explicitly
#   HOST_IP=192.168.1.42 scripts/dev-certs.sh
#
# Output: certs/dev-cert.pem + certs/dev-key.pem (git-ignored), mounted into the
# dev client container by compose.dev.yml. Re-run whenever your LAN IP changes.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'EOF'
mkcert is not installed. Install it, then re-run this script:
  Arch/CachyOS : sudo pacman -S mkcert nss
  Debian/Ubuntu: sudo apt install mkcert libnss3-tools
  macOS        : brew install mkcert nss
EOF
  exit 1
fi

# Pick the address the phone will type. Prefer an explicit arg/env; otherwise
# ask the OS which source IP it uses to reach the internet (its real LAN IP).
HOST_IP="${1:-${HOST_IP:-}}"
if [ -z "$HOST_IP" ]; then
  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null \
    | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
fi
if [ -z "$HOST_IP" ]; then
  echo "Could not auto-detect a LAN IP; pass one: scripts/dev-certs.sh <ip>" >&2
  exit 1
fi

# Create/trust the local CA (idempotent). This is what your phone must trust too.
mkcert -install

mkdir -p certs
mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem \
  localhost 127.0.0.1 ::1 "$HOST_IP"

cat <<EOF

✅ Cert written to certs/ for: localhost 127.0.0.1 ::1 $HOST_IP

Next:
  1. Copy the mkcert root CA to your phone and trust it (one time per device):
       $(mkcert -CAROOT)/rootCA.pem
     • Android: Settings ▸ Security ▸ Encryption & credentials ▸ Install a
       certificate ▸ CA certificate.
     • iOS: AirDrop/email the file, install the profile, then enable it under
       Settings ▸ General ▸ About ▸ Certificate Trust Settings.
  2. Start the stack:  make dev-up
  3. On the phone open: https://$HOST_IP:5173   (no warning, GPS works)
EOF
