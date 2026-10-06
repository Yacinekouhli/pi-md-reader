#!/usr/bin/env bash
# Run the Markdown Reader end-to-end test.
#
#   test/run.sh
#
# Uses /tmp/e2evenv if it exists, otherwise creates it. Override the interpreter with
# PYTHON=/path/to/python and the pi binary with PI_BIN=/path/to/pi.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="${E2E_VENV:-/tmp/e2evenv}"

if [[ ! -x "$venv/bin/python" ]]; then
  echo "creating python venv at $venv"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet pyte
fi

exec "${PYTHON:-$venv/bin/python}" "$here/e2e.py"
