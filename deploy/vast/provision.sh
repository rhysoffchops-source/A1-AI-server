#!/usr/bin/env bash
set -euo pipefail

# Rents one explicitly selected Vast offer. It does not search-and-pick a host for you,
# and it never launches without --apply. Use a short-lived/scoped Vast API key where possible.

api_base="https://console.vast.ai/api/v0"
image="${A1_VAST_IMAGE:-vastai/base-image:@vastai-automatic-tag}"
disk_gb="${A1_VAST_DISK_GB:-500}"
label="${A1_VAST_LABEL:-a1-gpu-worker}"
offer_id="${A1_VAST_OFFER_ID:-}"
volume_id="${A1_VAST_VOLUME_ID:-}"
volume_mount_path="${A1_VAST_VOLUME_MOUNT_PATH:-/workspace}"
apply=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      cat <<'USAGE'
Usage:
  A1_VAST_API_KEY=... A1_VAST_OFFER_ID=<chosen-offer> \
  A1_VAST_DISK_GB=500 A1_VAST_VOLUME_ID=<optional-existing-volume> \
  bash deploy/vast/provision.sh --apply

The script creates an SSH-direct instance using Vast's current base image. It does not put A1,
Tailscale, Hugging Face, or model credentials into Vast's instance-create API request. Bootstrap the
new instance separately with deploy/vast/bootstrap.sh after verifying its SSH host key.
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
  if [[ "${!name:-}" == "" ]]; then
    echo "$name is required." >&2
    exit 1
  fi
}
require_value A1_VAST_API_KEY
require_value A1_VAST_OFFER_ID
[[ "$disk_gb" =~ ^[0-9]+$ ]] && (( disk_gb >= 64 )) || {
  echo "A1_VAST_DISK_GB must be an integer of at least 64 GB." >&2
  exit 1
}
if [[ "$volume_id" != "" ]] && ! [[ "$volume_id" =~ ^[0-9]+$ ]]; then
  echo "A1_VAST_VOLUME_ID must be an existing numeric Vast volume ID." >&2
  exit 1
fi
command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

if [[ "$apply" != true ]]; then
  cat <<PLAN
Dry run only. This would rent exactly this selected Vast offer:
  offer:        $offer_id
  image:        $image
  local disk:   ${disk_gb} GB
  network volume: ${volume_id:-none}
  label:        $label
  connection:   ssh_direct

Run again with --apply after confirming the offer's live hourly price, reliability, disk, and GPU.
PLAN
  exit 0
fi

payload="$(
  jq -n \
    --arg image "$image" \
    --arg label "$label" \
    --arg mount_path "$volume_mount_path" \
    --argjson disk "$disk_gb" \
    --argjson volume_id "${volume_id:-null}" \
    '{image: $image, label: $label, disk: $disk, runtype: "ssh_direct", target_state: "running"}
     + (if $volume_id == null then {} else {volume_info: {volume_id: $volume_id, mount_path: $mount_path}} end)'
)"

response="$(
  curl --fail-with-body --silent --show-error \
    --request PUT \
    --url "${api_base}/asks/${offer_id}/" \
    --header "Authorization: Bearer ${A1_VAST_API_KEY}" \
    --header "Content-Type: application/json" \
    --data "$payload"
)"
instance_id="$(jq -r '.new_contract // .id // empty' <<<"$response")"
if [[ "$instance_id" == "" ]]; then
  echo "Vast did not return an instance contract ID:" >&2
  jq . <<<"$response" >&2
  exit 1
fi

echo "Created Vast instance ${instance_id}. Check status with:"
echo "  curl -s -H 'Authorization: Bearer \$A1_VAST_API_KEY' '${api_base}/instances/${instance_id}/' | jq ."
echo "After its SSH host key is verified, run deploy/vast/bootstrap.sh against this instance."
