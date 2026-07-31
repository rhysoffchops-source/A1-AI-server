#!/usr/bin/env bash
set -euo pipefail

# Deploys the A1 control plane on the VPS from a checked-out A1 repository.
# It keeps the API published only on 127.0.0.1; publish it to the tailnet with
# deploy/tailscale/connect-linux.sh and Tailscale Serve, never with Funnel.

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/../.." && pwd)"
runtime_directory="${A1_DEPLOY_CONFIG_DIR:-${project_root}/deploy/runtime}"
runtime_env="${runtime_directory}/runtime.env"
rendered_config="${runtime_directory}/production.yaml"
apply=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      cat <<'USAGE'
Usage:
  A1_MODAL_WATCHDOG_BASE_URL=https://<modal-endpoint>/v1 \
  A1_CONCIERGE_BASE_URL=http://a1-mac.tailffab8e.ts.net:11434/v1 \
  A1_ENABLE_VAST=false \
  bash deploy/vps/deploy.sh --apply

Preparation on the VPS:
  1. Install Docker Engine plus Compose v2.
  2. Copy deploy/vps/runtime.env.example to deploy/runtime.env and replace values.
  3. chmod 600 deploy/runtime.env.
  4. Create the authenticated Modal endpoint and pass its /v1 URL above.

This script renders non-secret production.yaml, validates the Compose configuration, builds the image,
starts it on loopback only, and checks /health/ready. It never opens a public API port.
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
  local value="${!name:-}"
  if [[ "$value" == "" ]]; then
    echo "$name is required." >&2
    exit 1
  fi
}
escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}
validate_runtime_env() {
  [[ -f "$runtime_env" ]] || {
    echo "Missing $runtime_env. Copy deploy/vps/runtime.env.example first." >&2
    exit 1
  }
  local permissions
  permissions="$(stat -c '%a' "$runtime_env")"
  # Prefix with 0 so Bash treats the mode as octal. `10#600` is decimal 600
  # and would incorrectly overlap with the group/other permission mask.
  if (( (0$permissions & 077) != 0 )); then
    echo "$runtime_env must be readable only by its owner (chmod 600)." >&2
    exit 1
  fi
  local name
  for name in \
    A1_SECRET_AUTH_TOKEN \
    A1_SECRET_SECRETS_MASTER_KEY \
    A1_SECRET_DASHBOARD_PASSPHRASE \
    A1_SECRET_MODAL_PROXY_TOKEN_ID \
    A1_SECRET_MODAL_PROXY_TOKEN_SECRET; do
    if ! grep -Eq "^${name}=[^[:space:]]+" "$runtime_env" || grep -Eq "^${name}=replace-" "$runtime_env"; then
      echo "$name must be set to a real value in $runtime_env." >&2
      exit 1
    fi
  done
}

require_value A1_MODAL_WATCHDOG_BASE_URL
require_value A1_CONCIERGE_BASE_URL
if [[ "${A1_ENABLE_VAST:-false}" != "true" && "${A1_ENABLE_VAST:-false}" != "false" ]]; then
  echo "A1_ENABLE_VAST must be true or false." >&2
  exit 1
fi
command -v docker >/dev/null || {
  echo "Docker Engine with Compose v2 must be installed on the VPS first." >&2
  exit 1
}
docker compose version >/dev/null
validate_runtime_env

if [[ "$apply" != true ]]; then
  cat <<PLAN
Dry run only. This will render and deploy A1 with:
  runtime config:  $runtime_directory
  Modal Watchdog: $A1_MODAL_WATCHDOG_BASE_URL
  Concierge:      $A1_CONCIERGE_BASE_URL
  Vast provider:  ${A1_ENABLE_VAST:-false}

Run again with --apply when these endpoints are correct.
PLAN
  exit 0
fi

install -d -m 700 "$runtime_directory"
temporary_config="${rendered_config}.$$"
sed \
  -e "s|__A1_MODAL_WATCHDOG_BASE_URL__|$(escape_sed "$A1_MODAL_WATCHDOG_BASE_URL")|g" \
  -e "s|__A1_CONCIERGE_BASE_URL__|$(escape_sed "$A1_CONCIERGE_BASE_URL")|g" \
  -e "s|__A1_ENABLE_VAST__|${A1_ENABLE_VAST:-false}|g" \
  "${script_directory}/production.yaml.template" >"$temporary_config"
# production.yaml contains only rendered endpoint and feature configuration;
# runtime.env remains the protected secret source. The container runs as the
# unprivileged `node` user and must be able to read this bind-mounted file.
chmod 644 "$temporary_config"
mv -f "$temporary_config" "$rendered_config"

export A1_DEPLOY_CONFIG_DIR="$runtime_directory"
# Compose resolves a build context relative to its project directory.  The base
# compose file deliberately uses `..` because it lives in docker/, so do not
# override that directory here or Docker will look for /opt/docker.
compose=(docker compose -f "$project_root/docker/compose.yaml" -f "$script_directory/compose.production.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" up --build --detach --remove-orphans

echo "Waiting for A1 readiness on VPS loopback..."
for attempt in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:8787/health/ready >/dev/null; then
    echo "A1 is ready. Keep it private: expose it only through Tailscale Serve."
    exit 0
  fi
  sleep 2
done

echo "A1 did not become ready. Inspect logs with:" >&2
echo "  ${compose[*]} logs --tail=200 api" >&2
exit 1
