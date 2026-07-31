#!/usr/bin/env bash
# Rebuild the private VPS dashboard from the M1 without relying on ~/.ssh/config.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

command -v tailscale >/dev/null || {
  echo "Tailscale is required on this Mac." >&2
  exit 1
}
command -v node >/dev/null || {
  echo "Node.js is required on this Mac." >&2
  exit 1
}

vps_address="$(
  tailscale status --json | node -e '
    const fs = require("fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const peers = Object.values(status.Peer || {});
    const vps = peers.find((peer) =>
      peer.HostName === "a1-vps" || String(peer.DNSName || "").startsWith("a1-vps.")
    );
    const address = vps?.TailscaleIPs?.find((ip) => ip.includes("."));
    if (!address) process.exit(1);
    process.stdout.write(address);
  '
)" || {
  echo "Could not find the a1-vps machine in Tailscale. Open Tailscale and ensure it is connected." >&2
  exit 1
}
vps_target="${A1_VPS_SSH_TARGET:-a1-vps}"

echo "Updating the private A1 dashboard on the VPS…"
# Transfer the source used by the Docker build, while preserving the VPS-only
# runtime secrets and avoiding local dependency/build directories. Copying only
# the stylesheet leaves API and UI feature changes stranded on the Mac.
tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./*/node_modules' \
  --exclude='./*/dist' \
  --exclude='./deploy/runtime' \
  -cf - . | /usr/bin/ssh -o ConnectTimeout=15 "${vps_target}" \
  'tar -xf - -C /opt/a1 && cd /opt/a1 && A1_DEPLOY_CONFIG_DIR=/opt/a1/deploy/runtime docker compose -f docker/compose.yaml -f deploy/vps/compose.production.yaml up --build --detach'

echo "Dashboard updated. Refresh the browser with Command + Shift + R."
