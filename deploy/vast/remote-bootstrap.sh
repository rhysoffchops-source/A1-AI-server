#!/usr/bin/env bash
set -euo pipefail

# Runs on the already-created Vast instance. bootstrap.sh uploads this file and a
# short-lived environment file, then invokes it through pinned-host-key SSH.

environment_file="${1:?temporary bootstrap environment file is required}"
# shellcheck disable=SC1090
source "$environment_file"
rm -f "$environment_file"

required() {
  local name="$1"
  [[ "${!name:-}" != "" ]] || { echo "$name is required." >&2; exit 1; }
}
for name in \
  A1_VAST_TAILSCALE_AUTH_KEY \
  A1_WORKER_CONTROL_URL \
  A1_WORKER_ID \
  A1_WORKER_TOKEN \
  A1_WORKER_ALLOWED_ROOTS \
  A1_WORKER_PROJECT_ROOTS; do
  required "$name"
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "The Vast bootstrap must run as root inside the instance." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git

if ! command -v node >/dev/null || (( $(node --eval 'process.stdout.write(process.versions.node.split(".")[0])') < 22 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install --yes nodejs
fi
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if command -v systemctl >/dev/null && systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
  systemctl enable --now tailscaled
else
  install -d -m 700 /var/lib/tailscale
  nohup tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
  for attempt in {1..15}; do
    tailscale status >/dev/null 2>&1 && break
    sleep 1
  done
fi

# The supplied key must have tag:a1-worker, be pre-authorized if your tailnet requires it,
# and have Ephemeral enabled. Do not add Tailscale Funnel on this instance.
tailscale up --auth-key="$A1_VAST_TAILSCALE_AUTH_KEY" --hostname="${A1_VAST_TAILSCALE_HOSTNAME:-a1-vast}"
unset A1_VAST_TAILSCALE_AUTH_KEY

install -d -m 700 /opt/a1 /var/lib/a1/locks
install -m 755 /tmp/a1-vast-bootstrap/a1-worker.mjs /opt/a1/a1-worker.mjs
install -m 755 /tmp/a1-vast-bootstrap/start-vllm.sh /opt/a1/start-vllm.sh

umask 077
{
  printf 'A1_WORKER_CONTROL_URL=%s\n' "$A1_WORKER_CONTROL_URL"
  printf 'A1_WORKER_ID=%s\n' "$A1_WORKER_ID"
  printf 'A1_WORKER_TOKEN=%s\n' "$A1_WORKER_TOKEN"
  printf 'A1_WORKER_ALLOWED_ROOTS=%s\n' "$A1_WORKER_ALLOWED_ROOTS"
  printf 'A1_WORKER_PROJECT_ROOTS=%s\n' "$A1_WORKER_PROJECT_ROOTS"
  printf 'A1_WORKER_DISCOVERY_DEPTH=%s\n' "${A1_WORKER_DISCOVERY_DEPTH:-3}"
  printf 'A1_WORKER_LOCK_DIRECTORY=%s\n' "/var/lib/a1/locks"
  printf 'A1_WORKER_ALLOW_SHELL=%s\n' "${A1_WORKER_ALLOW_SHELL:-false}"
} >/etc/a1-worker.env
chmod 600 /etc/a1-worker.env

if command -v systemctl >/dev/null && systemctl list-unit-files >/dev/null 2>&1; then
  cat >/etc/systemd/system/a1-worker.service <<'UNIT'
[Unit]
Description=A1 outbound worker
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/a1-worker.env
ExecStart=/usr/bin/node /opt/a1/a1-worker.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now a1-worker
  systemctl --no-pager --full status a1-worker
else
  # Some Vast SSH images are containers without systemd. The worker stays alive for the
  # instance lifetime; rerun bootstrap after replacing or rebooting that image.
  pkill -f '/opt/a1/a1-worker.mjs' || true
  set -a
  # shellcheck disable=SC1091
  source /etc/a1-worker.env
  set +a
  nohup node /opt/a1/a1-worker.mjs >/var/log/a1-worker.log 2>&1 &
  echo "A1 worker started without systemd; tail /var/log/a1-worker.log to inspect it."
fi

tailscale status
echo "Vast worker bootstrap completed. Start vLLM separately with deploy/vast/start-vllm.sh."
