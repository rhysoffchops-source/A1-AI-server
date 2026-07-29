#!/usr/bin/env bash
set -euo pipefail

# Prints a short-lived administrator bearer token. Paste it into the dashboard's
# Access token prompt; do not save it in a shell profile, URL, or shared document.

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/../.." && pwd)"
runtime_directory="${A1_DEPLOY_CONFIG_DIR:-${project_root}/deploy/runtime}"
operator_id="${A1_OPERATOR_ID:-dan}"
ttl_seconds="${A1_TOKEN_TTL_SECONDS:-3600}"

[[ "$ttl_seconds" =~ ^[0-9]+$ ]] && (( ttl_seconds > 0 )) || {
  echo "A1_TOKEN_TTL_SECONDS must be a positive integer." >&2
  exit 1
}
[[ -f "${runtime_directory}/runtime.env" ]] || {
  echo "Missing ${runtime_directory}/runtime.env. Deploy the VPS first." >&2
  exit 1
}

export A1_DEPLOY_CONFIG_DIR="$runtime_directory"
compose=(docker compose -f "$project_root/docker/compose.yaml" -f "$script_directory/compose.production.yaml")
"${compose[@]}" exec -T \
  -e "A1_OPERATOR_ID=$operator_id" \
  -e "A1_TOKEN_TTL_SECONDS=$ttl_seconds" \
  api node --input-type=module --eval '
    import { createHash } from "node:crypto";
    import { HmacTokenService } from "@a1/security";
    const secret = process.env.A1_SECRET_AUTH_TOKEN;
    if (!secret) throw new Error("A1_SECRET_AUTH_TOKEN is unavailable in the API container.");
    const service = new HmacTokenService({
      audience: "a1-api",
      issuer: "a1",
      secret: createHash("sha256").update(secret).digest(),
      ttlSeconds: Number(process.env.A1_TOKEN_TTL_SECONDS)
    });
    process.stdout.write(service.issue({
      id: process.env.A1_OPERATOR_ID,
      permissions: new Set(),
      roles: new Set(["administrator"])
    }));
  '
echo
