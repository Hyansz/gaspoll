#!/usr/bin/env sh
# Launcher for gaspoll on Unix-like systems
# Memeriksa keberadaan Node.js dan versi minimal 18
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js tidak ditemukan, silakan instal Node.js versi >= 18."
  exit 1
fi
node_version=$(node -v | cut -c2-)
major=$(printf "%s" "$node_version" | cut -d. -f1)
if [ "$major" -lt 18 ]; then
  echo "Node.js versi $node_version terlalu lama, butuh >= 18."
  exit 1
fi
cd "$(dirname "$0")"
exec node src/cli.js "$@"