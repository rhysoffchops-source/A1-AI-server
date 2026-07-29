#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/.." && pwd)"

cd "${project_root}"

node_major="$(node --eval 'process.stdout.write(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "A1 requires Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

npm run verify

echo "A1 is ready. Start it with: npm start"
