#!/usr/bin/env bash
set -euo pipefail

# Receives a one-time protected worker token over an SSH tar stream from the
# M1 installer. This script is deliberately run as root on the VPS.

stage_token_file="${1:-}"
worker_id="${2:-}"
project_root="/opt/a1"
runtime_directory="${project_root}/deploy/runtime"
runtime_environment="${runtime_directory}/runtime.env"
rendered_config="${runtime_directory}/production.yaml"

fail() {
  echo "Remote worker enrollment: $*" >&2
  exit 1
}
provider_url() {
  local provider_id="$1"
  awk -v provider_id="${provider_id}" '
    $1 == "-" && $2 == "id:" && $3 == provider_id { in_provider = 1; next }
    in_provider && $1 == "baseUrl:" { print $2; exit }
    in_provider && $1 == "-" && $2 == "id:" { exit }
  ' "${rendered_config}"
}

[[ "$(id -u)" == "0" ]] || fail "Run as root on the VPS."
[[ -f "${stage_token_file}" ]] || fail "Missing transferred M1 worker token."
case "${worker_id}" in
  m1|intel) ;;
  *) fail "Worker id must be m1 or intel." ;;
esac
[[ -f "${runtime_environment}" ]] || fail "Missing ${runtime_environment}."
[[ -f "${rendered_config}" ]] || fail "Deploy A1 before enrolling the M1 worker."
[[ -d "${project_root}" ]] || fail "Missing ${project_root}."

worker_token="$(tr -d '\r\n' <"${stage_token_file}")"
[[ "${worker_token}" =~ ^[A-Za-z0-9._~-]{32,}$ ]] || fail "Transferred worker token is invalid."
modal_url="$(provider_url modal-code-watchdog)"
concierge_url="$(provider_url m1-concierge)"
[[ "${modal_url}" == https://* ]] || fail "Could not read the Modal endpoint from existing A1 configuration."
[[ "${concierge_url}" == http://* || "${concierge_url}" == https://* ]] ||
  fail "Could not read the Concierge endpoint from existing A1 configuration."

token_key="A1_SECRET_WORKERS_$(printf '%s' "${worker_id}" | tr '[:lower:]' '[:upper:]')_TOKEN"
install -d -m 700 "${runtime_directory}"
temporary_environment="$(mktemp "${runtime_environment}.XXXXXX")"
grep -v "^${token_key}=" "${runtime_environment}" >"${temporary_environment}" || true
printf '%s=%s\n' "${token_key}" "${worker_token}" >>"${temporary_environment}"
install -m 600 "${temporary_environment}" "${runtime_environment}"
rm -f "${temporary_environment}"

stage_directory="$(cd -- "$(dirname -- "${stage_token_file}")" && pwd)"
cp -a "${stage_directory}/deploy/vps/." "${project_root}/deploy/vps/"

cd "${project_root}"
A1_MODAL_WATCHDOG_BASE_URL="${modal_url}" \
  A1_CONCIERGE_BASE_URL="${concierge_url}" \
  A1_ENABLE_VAST=false \
  bash deploy/vps/deploy.sh --apply

echo "VPS enrolled the ${worker_id} worker definition and restarted A1."
