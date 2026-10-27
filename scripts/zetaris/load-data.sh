#!/usr/bin/env bash
# Copies the synthetic CSVs into the Zetaris driver container. Run inside the Codespace,
# where Docker is; Lightning FILESTORE tables read the files from this path in the container.
set -euo pipefail

CONTAINER="${ZETARIS_CONTAINER:-zetaris-driver-1}"
TARGET_DIR="/home/zetaris/customer-data/shared/growthloop"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
FILES=(posts.csv post_metrics.csv ad_spend.csv sales.csv)

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found: run this script inside the Codespace that hosts Zetaris." >&2
  exit 1
fi

if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container '$CONTAINER' does not exist. Containers on this host:" >&2
  docker ps -a --format '  {{.Names}} ({{.Status}})' >&2
  exit 1
fi

if [[ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
  echo "Container '$CONTAINER' exists but is not running. Start Zetaris first." >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  if [[ ! -f "$DATA_DIR/$f" ]]; then
    echo "Missing $DATA_DIR/$f (run: npm run data:generate, or git pull)." >&2
    exit 1
  fi
done

docker exec "$CONTAINER" mkdir -p "$TARGET_DIR"

for f in "${FILES[@]}"; do
  # stdin redirect: works without docker cp and without the file being visible to the container.
  docker exec -i "$CONTAINER" sh -c "cat > '$TARGET_DIR/$f'" < "$DATA_DIR/$f"
  echo "copied $f ($(( $(wc -l < "$DATA_DIR/$f") - 1 )) data rows)"
done

echo
echo "Files in $CONTAINER:$TARGET_DIR"
docker exec "$CONTAINER" ls -l "$TARGET_DIR"
docker exec "$CONTAINER" sh -c "cd '$TARGET_DIR' && wc -l ${FILES[*]}"
