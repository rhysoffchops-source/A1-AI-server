#!/usr/bin/env bash
set -euo pipefail

# Creates the dedicated, authenticated Modal endpoint used only by A1's Code Watchdog.
# This script deliberately does not create an unauthenticated endpoint or write proxy-token
# secrets to disk. Run it in your own terminal after setting any Modal account budget guardrails.

model_id="Qwen/Qwen3.6-27B-FP8"
environment="${MODAL_ENVIRONMENT:-a1}"
endpoint_name="${A1_MODAL_WATCHDOG_NAME:-a1-code-watchdog}"
modal_cli="${A1_MODAL_CLI:-modal}"
apply=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      cat <<'USAGE'
Usage:
  MODAL_ENVIRONMENT=a1 bash deploy/modal/create-code-watchdog.sh --apply

Before --apply:
  1. Set your Modal account budget/alert policy. This script cannot enforce account billing limits.
  2. Confirm that Qwen/Qwen3.6-27B-FP8 is the intended dedicated Code Watchdog model.
  3. Keep the endpoint authenticated. Do not pass --unauthenticated.

The script prints the endpoint URL. It then explains how to create an authenticated proxy-token pair;
store that pair only in the VPS runtime.env file as the A1_SECRET_MODAL_PROXY_TOKEN_* values.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

command -v "$modal_cli" >/dev/null || {
  echo "Modal CLI is required. Install it, authenticate it, then rerun this script." >&2
  exit 1
}

if [[ "$apply" != true ]]; then
  cat <<USAGE
Dry run only. This would create:
  environment: $environment
  endpoint:    $endpoint_name
  model:       $model_id
  auth:        required (no public endpoint)

Run again with --apply once your Modal budget guardrails are set.
USAGE
  exit 0
fi

echo "Creating authenticated Modal Code Watchdog endpoint..."
"$modal_cli" endpoint create \
  --env "$environment" \
  --name "$endpoint_name" \
  --model "$model_id"

echo
echo "Endpoint created. Retrieve its /v1 URL with:"
echo "  modal endpoint list --env '$environment' --json"
echo
echo "Create a dedicated proxy-token pair now (the secret is displayed only once):"
echo "  modal workspace proxy-tokens create"
echo
echo "Store the values only on the VPS in deploy/runtime.env as:"
echo "  A1_SECRET_MODAL_PROXY_TOKEN_ID=<Modal-Key>"
echo "  A1_SECRET_MODAL_PROXY_TOKEN_SECRET=<Modal-Secret>"
echo
echo "Then deploy the VPS with A1_MODAL_WATCHDOG_BASE_URL=<endpoint-url>/v1."
