#!/usr/bin/env bash
# Run on the M1 to refresh only the Intel worker installer after a safe fix.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${project_root}"

command -v tailscale >/dev/null || {
  echo "Intel installer refresh: Tailscale is required." >&2
  exit 1
}
command -v node >/dev/null || {
  echo "Intel installer refresh: Node.js is required." >&2
  exit 1
}

intel_address="$(
  tailscale status --json | node -e '
    const fs = require("fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const peer = Object.values(status.Peer || {}).find((item) =>
      item.HostName === "a1-intel" || String(item.DNSName || "").startsWith("a1-intel.")
    );
    const address = peer?.TailscaleIPs?.find((item) => item.includes("."));
    if (!address) process.exit(1);
    process.stdout.write(address);
  '
)" || {
  echo "Intel installer refresh: could not find a1-intel in Tailscale." >&2
  exit 1
}

tar -cf - deploy/m1/enroll-worker.sh | /usr/bin/ssh -F /dev/null "dan@${intel_address}" \
  'tar -xf - -C "$HOME/Documents/A1"'
echo "Intel worker installer refreshed."
