#!/usr/bin/env bash
set -euo pipefail

# Enrolls a trusted macOS machine as an A1 worker. It creates a random per-worker token,
# transfers it to the VPS over the existing private SSH/Tailscale path, updates
# the VPS worker declaration, then installs a user LaunchAgent that survives
# logout and restart. Nothing is exposed publicly.

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/../.." && pwd)"
node_binary="${A1_NODE_BIN:-$(command -v node || true)}"
control_url="${A1_CONTROL_URL:-}"
vps_target="${A1_VPS_SSH_TARGET:-}"
worker_id="${A1_WORKER_ID:-m1}"
allowed_roots="${A1_WORKER_ALLOWED_ROOTS:-${project_root}}"
project_roots="${A1_WORKER_PROJECT_ROOTS:-${project_root}}"
worker_directory="${HOME}/.config/a1-worker"
worker_environment="${worker_directory}/${worker_id}.env"
worker_launcher="${worker_directory}/start-${worker_id}.sh"
launch_agent="${HOME}/Library/LaunchAgents/com.a1.worker.${worker_id}.plist"
worker_script="${project_root}/scripts/a1-worker.mjs"
log_directory="${HOME}/Library/Logs"

fail() {
  echo "A1 macOS worker setup: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "Run this installer on a trusted Mac."
[[ -n "${node_binary}" && -x "${node_binary}" ]] || fail "Node.js 22 or later is required."
[[ -f "${worker_script}" ]] || fail "Missing ${worker_script}."
command -v curl >/dev/null || fail "curl is required."
command -v openssl >/dev/null || fail "openssl is required."
command -v ssh >/dev/null || fail "ssh is required."
command -v tar >/dev/null || fail "tar is required."
command -v tailscale >/dev/null || fail "Tailscale is required."

node_major="$("${node_binary}" -p 'process.versions.node.split(".")[0]')"
[[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) || fail "Node.js 22 or later is required."

vps_details="$(
  tailscale status --json | "${node_binary}" -e '
    const fs = require("fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const peer = Object.values(status.Peer || {}).find((item) =>
      item.HostName === "a1-vps" || String(item.DNSName || "").startsWith("a1-vps.")
    );
    const ip = peer?.TailscaleIPs?.find((item) => item.includes("."));
    const dns = String(peer?.DNSName || "").replace(/\.$/, "");
    if (!ip || !dns) process.exit(1);
    process.stdout.write(`${ip}\t${dns}`);
  '
)" || fail "Could not find a1-vps in Tailscale."
vps_address="${vps_details%%$'\t'*}"
vps_dns_name="${vps_details#*$'\t'}"
[[ -n "${vps_address}" && -n "${vps_dns_name}" && "${vps_address}" != "${vps_dns_name}" ]] ||
  fail "Tailscale did not provide the VPS address."
[[ -n "${control_url}" ]] || control_url="https://${vps_dns_name}"
[[ -n "${vps_target}" ]] || vps_target="root@${vps_address}"
[[ "${control_url}" == https://* ]] || fail "Set A1_CONTROL_URL to the VPS's private https address."

for root in ${allowed_roots//:/ }; do
  [[ -d "${root}" ]] || fail "Approved worker root does not exist: ${root}"
done
for root in ${project_roots//:/ }; do
  [[ -d "${root}" ]] || fail "Managed project root does not exist: ${root}"
done

curl --fail --silent --show-error --max-time 15 "${control_url}/health/live" >/dev/null ||
  fail "The M1 cannot reach the private A1 dashboard. Confirm Tailscale is connected."

umask 077
stage_directory="$(mktemp -d "${TMPDIR:-/tmp}/a1-m1-enroll.XXXXXX")"
cleanup() {
  rm -rf "${stage_directory}"
}
trap cleanup EXIT

worker_token="$(openssl rand -hex 32)"
install -d -m 700 "${worker_directory}" "${log_directory}" "${stage_directory}/deploy"
printf '%s\n' "${worker_token}" >"${stage_directory}/worker-token"
chmod 600 "${stage_directory}/worker-token"
printf '%s\n' "${worker_id}" >"${stage_directory}/worker-id"
chmod 600 "${stage_directory}/worker-id"
cp -R "${project_root}/deploy/vps" "${stage_directory}/deploy/vps"
cp -R "${project_root}/deploy/m1" "${stage_directory}/deploy/m1"

echo "Connecting to the VPS once to enroll the protected ${worker_id} worker token."
tar -C "${stage_directory}" -cf - deploy worker-token worker-id | /usr/bin/ssh -F /dev/null "${vps_target}" '
  set -euo pipefail
  stage_directory="$(mktemp -d /tmp/a1-m1-enroll.XXXXXX)"
  cleanup() { rm -rf "${stage_directory}"; }
  trap cleanup EXIT
  tar -C "${stage_directory}" -xf -
  bash "${stage_directory}/deploy/m1/remote-enroll.sh" "${stage_directory}/worker-token" "$(tr -d "\r\n" <"${stage_directory}/worker-id")"
'

printf '%s\n' \
  "A1_WORKER_CONTROL_URL=${control_url%/}" \
  "A1_WORKER_ID=${worker_id}" \
  "A1_WORKER_TOKEN=${worker_token}" \
  "A1_WORKER_ALLOWED_ROOTS=${allowed_roots}" \
  "A1_WORKER_PROJECT_ROOTS=${project_roots}" \
  "A1_WORKER_DISCOVERY_DEPTH=3" \
  "A1_WORKER_ALLOW_SHELL=true" \
  "A1_WORKER_LOCK_DIRECTORY=${HOME}/.a1-worker-locks" >"${worker_environment}"
chmod 600 "${worker_environment}"

printf '#!/bin/zsh\nset -euo pipefail\nset -a\nsource "%s"\nset +a\nexec "%s" "%s"\n' \
  "${worker_environment}" "${node_binary}" "${worker_script}" >"${worker_launcher}"
chmod 700 "${worker_launcher}"

printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0">' \
  '<dict>' \
  "  <key>Label</key><string>com.a1.worker.${worker_id}</string>" \
  '  <key>ProgramArguments</key>' \
  '  <array>' \
  "    <string>${worker_launcher}</string>" \
  '  </array>' \
  '  <key>RunAtLoad</key><true/>' \
  '  <key>KeepAlive</key><true/>' \
  "  <key>StandardOutPath</key><string>${log_directory}/a1-worker-${worker_id}.log</string>" \
  "  <key>StandardErrorPath</key><string>${log_directory}/a1-worker-${worker_id}-error.log</string>" \
  '</dict>' \
  '</plist>' >"${launch_agent}"
chmod 600 "${launch_agent}"
plutil -lint "${launch_agent}" >/dev/null

user_id="$(id -u)"
launchctl bootout "gui/${user_id}" "${launch_agent}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${user_id}" "${launch_agent}"
launchctl kickstart -k "gui/${user_id}/com.a1.worker.${worker_id}"

echo "${worker_id} worker installed and started. Refresh the A1 dashboard and open Workers."
echo "Only Git projects inside ${project_roots} are governed by the Code Watchdog."
