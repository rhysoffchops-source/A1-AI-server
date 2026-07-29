#!/usr/bin/env bash
set -euo pipefail

# One-time Ubuntu/Debian VPS preparation. Run explicitly with --apply as root.
# It installs only the package-manager Docker build and basic deployment tools.

apply=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --help)
      echo "Usage: sudo bash deploy/vps/bootstrap.sh --apply"
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo on the VPS." >&2
  exit 1
fi
if [[ "$apply" != true ]]; then
  echo "Dry run: installs curl, git, rsync, Docker Engine package, and Docker Compose v2 package."
  echo "Run again with --apply to modify this VPS."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git rsync docker.io docker-compose-v2
systemctl enable --now docker
docker compose version
echo "VPS prerequisites are ready. Next, connect Tailscale and run deploy/vps/deploy.sh."
