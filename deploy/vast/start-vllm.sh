#!/usr/bin/env bash
set -euo pipefail

# Run this *inside* the bootstrapped Vast instance. It starts one OpenAI-compatible
# vLLM server on loopback and exposes it only through Tailscale Serve.

model_id="${A1_VAST_MODEL_ID:-}"
model_api_key="${A1_VAST_MODEL_API_KEY:-}"
model_cache="${A1_VAST_MODEL_CACHE:-/workspace/model-cache}"
port="${A1_VAST_VLLM_PORT:-8000}"
apply=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      cat <<'USAGE'
Usage on the Vast instance:
  A1_VAST_MODEL_ID=<Hugging-Face-model-id> \
  A1_VAST_MODEL_API_KEY=<long-random-model-key> \
  A1_VAST_HF_TOKEN=<optional-gated-model-token> \
  bash /opt/a1/start-vllm.sh --apply

The model cache defaults to /workspace/model-cache so an attached Vast volume retains weights. vLLM
listens only on 127.0.0.1. Tailscale Serve is the sole route to it; do not expose port 8000 publicly.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

[[ "$model_id" != "" ]] || { echo "A1_VAST_MODEL_ID is required." >&2; exit 1; }
[[ "$model_api_key" != "" ]] || { echo "A1_VAST_MODEL_API_KEY is required." >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] || { echo "A1_VAST_VLLM_PORT must be numeric." >&2; exit 1; }
command -v tailscale >/dev/null || { echo "Bootstrap Tailscale first." >&2; exit 1; }

if [[ "$apply" != true ]]; then
  cat <<PLAN
Dry run only. This will download and serve:
  model: $model_id
  cache: $model_cache
  local: http://127.0.0.1:$port/v1
  tailnet: private Tailscale Serve HTTPS endpoint

Run again with --apply after confirming the GPU has enough VRAM for this exact model.
PLAN
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Vast instance so the service can be kept private and durable." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes python3-pip
if ! python3 -c 'import vllm' >/dev/null 2>&1; then
  python3 -m pip install --break-system-packages vllm
fi

install -d -m 700 "$model_cache"
umask 077
{
  printf 'A1_VAST_MODEL_ID=%s\n' "$model_id"
  printf 'A1_VAST_MODEL_API_KEY=%s\n' "$model_api_key"
  printf 'A1_VAST_MODEL_CACHE=%s\n' "$model_cache"
  printf 'A1_VAST_VLLM_PORT=%s\n' "$port"
  if [[ "${A1_VAST_HF_TOKEN:-}" != "" ]]; then
    printf 'HF_TOKEN=%s\n' "$A1_VAST_HF_TOKEN"
  fi
} >/etc/a1-vllm.env
chmod 600 /etc/a1-vllm.env

pkill -f 'vllm serve' || true
set -a
# shellcheck disable=SC1091
source /etc/a1-vllm.env
set +a
nohup vllm serve "$A1_VAST_MODEL_ID" \
  --host 127.0.0.1 \
  --port "$A1_VAST_VLLM_PORT" \
  --api-key "$A1_VAST_MODEL_API_KEY" \
  --download-dir "$A1_VAST_MODEL_CACHE" >/var/log/a1-vllm.log 2>&1 &

for attempt in {1..90}; do
  if curl --fail --silent --show-error \
    -H "Authorization: Bearer $A1_VAST_MODEL_API_KEY" \
    "http://127.0.0.1:${A1_VAST_VLLM_PORT}/v1/models" >/dev/null; then
    break
  fi
  sleep 2
  if [[ "$attempt" == 90 ]]; then
    echo "vLLM did not become ready; inspect /var/log/a1-vllm.log." >&2
    exit 1
  fi
done

echo "Publishing vLLM privately through Tailscale Serve. First use may require tailnet HTTPS consent."
tailscale serve --https=443 --bg "http://127.0.0.1:${A1_VAST_VLLM_PORT}"
tailscale serve status
echo "vLLM is ready. Use the shown https://<tailnet-name>/v1 URL with its separate bearer API key."
