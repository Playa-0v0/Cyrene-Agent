#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$HOME/cyrene-gcp-free.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/cyrene-gcp-free/cloud-bot/src" "$STAGE/cyrene-gcp-free/prompts"
cp "$ROOT/cloud-bot/package.json" "$ROOT/cloud-bot/package-lock.json" "$ROOT/cloud-bot/tsconfig.json" "$ROOT/cloud-bot/.env.example" "$STAGE/cyrene-gcp-free/cloud-bot/"
cp "$ROOT/cloud-bot/src/"*.ts "$STAGE/cyrene-gcp-free/cloud-bot/src/"
cp "$ROOT/prompts/system.md" "$ROOT/prompts/identity.md" "$ROOT/prompts/soul.md" "$ROOT/prompts/tone-rules.md" "$STAGE/cyrene-gcp-free/prompts/"
cp "$ROOT/cloud-bot/GCP_FREE_DEPLOY.md" "$STAGE/cyrene-gcp-free/"

rm -f "$OUT"
(cd "$STAGE" && zip -q -r "$OUT" cyrene-gcp-free)
echo "Created: $OUT"
du -h "$OUT"
