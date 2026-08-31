#!/usr/bin/env bash
# Compatibility shim. The supported workflow is `python scripts/make.py ...`.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python "$SCRIPT_DIR/make.py" "$@"
