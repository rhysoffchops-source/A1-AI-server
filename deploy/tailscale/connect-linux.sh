#!/usr/bin/env bash
set -euo pipefail

# Connects a Linux machine to the A1 tailnet. On the VPS and Intel, run this once
# as root or with sudo. Do not use it for the Vast GPU; that is handled by the
# disposable-worker bootstrap and requires a tagged ephemeral auth key.

hostname_value="${A1_TAILSCALE_HOSTNAME:-}"
auth_key="${A1_TAILSCALE_AUTH_KEY:-}"
serve_target="${A1_TAILSCALE_SERVE_TARGET:-}"

if [[ "$hostname_value" == "" ]]; then
  echo "Set A1_TAILSCALE_HOSTNAME (for example a1-vps or a1-intel)." >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo so it can install and start Tailscale." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null; then
  command -v curl >/dev/null || {
    echo "curl is required to install Tailscale." >&2
    exit 1
  }
  echo "Installing Tailscale from the official stable installer..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if [[ "$auth_key" == "" ]]; then
  echo "No auth key supplied. Tailscale will print a one-time browser login URL."
  tailscale up --hostname="$hostname_value"
else
  # Keep the key in the process environment rather than shell history. Use a one-off
  # key for persistent machines, and a tagged ephemeral key only for disposable GPU nodes.
  tailscale up --auth-key="$auth_key" --hostname="$hostname_value"
fi

tailscale status

if [[ "$serve_target" != "" ]]; then
  echo "Publishing $serve_target privately through Tailscale Serve..."
  echo "If this is the first Serve use, Tailscale may print a consent URL; follow it once."
  tailscale serve --bg "$serve_target"
  tailscale serve status
fi
