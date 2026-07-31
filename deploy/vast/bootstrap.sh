#!/usr/bin/env bash
set -euo pipefail

# Uploads the A1 worker to an already-rented Vast instance and starts its private
# Tailscale connection. It refuses SSH unless the instance host key is already pinned.

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/../.." && pwd)"
host="${A1_VAST_SSH_HOST:-}"
port="${A1_VAST_SSH_PORT:-22}"
user="${A1_VAST_SSH_USER:-root}"
known_hosts="${A1_VAST_KNOWN_HOSTS_FILE:-}"
remote_directory="/tmp/a1-vast-bootstrap"
apply=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      cat <<'USAGE'
Usage:
  A1_VAST_SSH_HOST=<Vast SSH host> A1_VAST_SSH_PORT=<port> \
  A1_VAST_KNOWN_HOSTS_FILE=<pinned-known-hosts-file> \
  A1_VAST_TAILSCALE_AUTH_KEY=<tagged-ephemeral-key> \
  A1_WORKER_CONTROL_URL=https://a1-vps.<tailnet>.ts.net \
  A1_WORKER_TOKEN=<dedicated-vast-worker-token> \
  bash deploy/vast/bootstrap.sh --apply

The Vast SSH host key must first be inspected and explicitly added to the known-hosts file. The script
does not call ssh-keyscan or disable host-key checking. The Tailscale key must be tagged and ephemeral.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

require_value() {
  local name="$1"
  [[ "${!name:-}" != "" ]] || { echo "$name is required." >&2; exit 1; }
}
for name in \
  A1_VAST_SSH_HOST \
  A1_VAST_KNOWN_HOSTS_FILE \
  A1_VAST_TAILSCALE_AUTH_KEY \
  A1_WORKER_CONTROL_URL \
  A1_WORKER_TOKEN; do
  require_value "$name"
done
[[ -f "$known_hosts" ]] || { echo "Pinned known-hosts file does not exist: $known_hosts" >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] || { echo "A1_VAST_SSH_PORT must be numeric." >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required." >&2; exit 1; }
command -v scp >/dev/null || { echo "scp is required." >&2; exit 1; }

worker_id="${A1_WORKER_ID:-vast-gpu}"
allowed_roots="${A1_WORKER_ALLOWED_ROOTS:-/workspace}"
project_roots="${A1_WORKER_PROJECT_ROOTS:-/workspace}"

if [[ "$apply" != true ]]; then
  cat <<PLAN
Dry run only. This will bootstrap the pinned Vast host:
  host:       $host:$port
  worker id:  $worker_id
  roots:      $project_roots
  control:    $A1_WORKER_CONTROL_URL

Run again with --apply after confirming this SSH host key belongs to the current Vast instance.
PLAN
  exit 0
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
bootstrap_env="${temporary_directory}/bootstrap.env"
umask 077
{
  printf 'A1_VAST_TAILSCALE_AUTH_KEY=%s\n' "$A1_VAST_TAILSCALE_AUTH_KEY"
  printf 'A1_VAST_TAILSCALE_HOSTNAME=%s\n' "${A1_VAST_TAILSCALE_HOSTNAME:-a1-vast}"
  printf 'A1_WORKER_CONTROL_URL=%s\n' "$A1_WORKER_CONTROL_URL"
  printf 'A1_WORKER_ID=%s\n' "$worker_id"
  printf 'A1_WORKER_TOKEN=%s\n' "$A1_WORKER_TOKEN"
  printf 'A1_WORKER_ALLOWED_ROOTS=%s\n' "$allowed_roots"
  printf 'A1_WORKER_PROJECT_ROOTS=%s\n' "$project_roots"
  printf 'A1_WORKER_DISCOVERY_DEPTH=%s\n' "${A1_WORKER_DISCOVERY_DEPTH:-3}"
  printf 'A1_WORKER_ALLOW_SHELL=%s\n' "${A1_WORKER_ALLOW_SHELL:-false}"
} >"$bootstrap_env"
chmod 600 "$bootstrap_env"

ssh_options=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${known_hosts}"
  -p "$port"
)
scp_options=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${known_hosts}"
  -P "$port"
)
remote="${user}@${host}"
ssh "${ssh_options[@]}" -i "$A1_VAST_SSH_KEY" "$remote" "rm -rf '$remote_directory' && mkdir -p '$remote_directory'"
scp -i "$A1_VAST_SSH_KEY" "${scp_options[@]}" \
  "$project_root/scripts/a1-worker.mjs" \
  "$script_directory/start-vllm.sh" \
  "$script_directory/remote-bootstrap.sh" \
  "$bootstrap_env" \
  "${remote}:${remote_directory}/"
ssh "${ssh_options[@]}" -i "$A1_VAST_SSH_KEY" "$remote" \
  "bash '${remote_directory}/remote-bootstrap.sh' '${remote_directory}/bootstrap.env'"
