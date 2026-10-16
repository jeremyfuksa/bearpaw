#!/usr/bin/env bash
# Run Bearpaw against a fake scanner, for demos and screen recordings.
#
#   tools/fake-scanner/demo.sh [browser|desktop] [BC125AT|BC75XLT]
#
# browser: backend + Vite dev server; open http://localhost:5173.
# desktop: the real Tauri window, its backend in-process.
#
# Everything lives in /tmp/bearpaw-demo (override with BEARPAW_DEMO_DIR), so
# your real scanner list, channel cache and history are never touched. The
# first run seeds a week of hit history for both models; delete the directory
# to start over. Swap scanners mid-take with:  pkill -USR1 -f fake_scanner.py
set -euo pipefail

mode=${1:-browser}
model=${2:-BC125AT}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=${BEARPAW_DEMO_DIR:-/tmp/bearpaw-demo}

case $mode in browser | desktop) ;; *)
  echo "usage: $0 [browser|desktop] [BC125AT|BC75XLT]" >&2
  exit 2
  ;;
esac
if lsof -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 8000 is in use; quit Bearpaw (or whatever holds it) first" >&2
  exit 1
fi

mkdir -p "$work/logs"
cat >"$work/config.yaml" <<EOF
device:
  port: $work/scanner
api:
  host: 127.0.0.1
  port: 8000
EOF
export BEARPAW_CONFIG=$work/config.yaml
export BEARPAW_DATA_DIR=$work
export BEARPAW_PREFERENCES_DB=$work/scanner.db
export BEARPAW_ANALYTICS_DB=$work/analytics.db
export BEARPAW_LOG_DIR=$work/logs

# macOS cannot set a baud rate on a pty; see pty_shim.c. DYLD_INSERT_LIBRARIES
# is set per command below, never exported: macOS strips it from anything run
# through /bin/sh (npm, cargo), so it must go on the binary itself.
clang -dynamiclib -o "$work/pty_shim.dylib" "$here/pty_shim.c"
shim=$work/pty_shim.dylib

trap 'kill $(jobs -p) 2>/dev/null' EXIT
python3 "$here/fake_scanner.py" --link "$work/scanner" --model "$model" --quiet &

cargo build --manifest-path "$repo/Cargo.toml" -p bearpaw-api --bin bearpaw
backend=$repo/target/debug/bearpaw

if [ ! -f "$work/analytics.db" ]; then
  # The backend creates and migrates the databases at startup; the seeder
  # only adds rows to a schema that already exists.
  DYLD_INSERT_LIBRARIES=$shim "$backend" --config "$BEARPAW_CONFIG" >/dev/null 2>&1 &
  until curl -sf localhost:8000/api/v1/status >/dev/null; do sleep 0.5; done
  kill $!
  wait $! 2>/dev/null || true
  for m in BC125AT BC75XLT; do
    python3 "$here/fake_scanner.py" --model "$m" --seed-history "$work/analytics.db"
  done
fi

cd "$repo/frontend"
if [ "$mode" = browser ]; then
  DYLD_INSERT_LIBRARIES=$shim "$backend" --config "$BEARPAW_CONFIG" &
  npm run dev
else
  # A plain debug build loads the UI from Vite's devUrl, like tauri:dev does.
  npm run dev >/dev/null &
  cargo build --manifest-path "$repo/Cargo.toml" -p bearpaw-desktop
  DYLD_INSERT_LIBRARIES=$shim "$repo/target/debug/bearpaw-desktop"
fi
