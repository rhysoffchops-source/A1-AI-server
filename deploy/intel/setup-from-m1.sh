#!/usr/bin/env bash
# Run on the M1. Copies the committed, non-secret A1 baseline to a1-intel over
# Tailscale, creates an Intel-local Git baseline, and installs dependencies.
# Worker enrolment is deliberately a separate interactive step on Intel so its
# VPS password prompt always has a real terminal.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${project_root}"

fail() {
  echo "Intel setup: $*" >&2
  exit 1
}

command -v tailscale >/dev/null || fail "Tailscale is required on the M1."
command -v node >/dev/null || fail "Node.js is required on the M1."
command -v git >/dev/null || fail "Git is required on the M1."
command -v ssh >/dev/null || fail "ssh is required on the M1."
command -v tar >/dev/null || fail "tar is required on the M1."
git diff --quiet && git diff --cached --quiet ||
  fail "Commit the current A1 changes before copying the Intel baseline."
replace_existing="${A1_REPLACE_INTEL_BASELINE:-false}"
[[ "${replace_existing}" == "true" || "${replace_existing}" == "false" ]] ||
  fail "A1_REPLACE_INTEL_BASELINE must be true or false."

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
)" || fail "Could not find a1-intel in Tailscale."

if [[ "${replace_existing}" == "true" ]]; then
  echo "Preserving the incomplete Intel copy before transfer."
  /usr/bin/ssh -F /dev/null "dan@${intel_address}" '
    set -euo pipefail
    destination="$HOME/Documents/A1"
    if [ -e "$destination" ]; then
      backup="$HOME/Documents/A1.incomplete.$(date +%Y%m%d-%H%M%S)"
      mv "$destination" "$backup"
      echo "Moved the incomplete Intel copy to $backup"
    fi
  '
fi

echo "Copying the private A1 baseline to Intel. You may be asked for the Intel password."
git archive --format=tar HEAD | /usr/bin/ssh -F /dev/null "dan@${intel_address}" '
  set -euo pipefail
  destination="$HOME/Documents/A1"
  if [ -e "$destination" ]; then
    echo "Intel setup: $destination already exists; refusing to overwrite it." >&2
    exit 1
  fi
  mkdir -p "$destination"
  tar -xf - -C "$destination"
  cd "$destination"
  git init --initial-branch=main >/dev/null
  git add --all
  git -c user.name="Dan" -c user.email="dan@a1.local" commit -m "chore: establish Intel watchdog baseline" >/dev/null
  npm ci
 '

echo "Intel baseline is ready. On Intel, run: cd /Users/dan/Documents/A1 && A1_WORKER_ID=intel bash deploy/m1/enroll-worker.sh"
