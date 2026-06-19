#!/usr/bin/env bash
# Build a self-hosted Great Britain vector tileset (OpenMapTiles schema) with
# planetiler. Free, no account. Output: ./tiles/gb.mbtiles, which TileServer GL
# (the dronefly-tiles service) serves with its bundled styles/fonts/sprites.
#
# Run ONCE on the VPS before bringing up dronefly-tiles. Takes a few minutes and
# needs ~2-4 GB RAM free. Re-run any time to refresh the map data.
set -euo pipefail

AREA="${1:-great-britain}"   # any Geofabrik area name, e.g. ireland-and-northern-ireland
mkdir -p tiles

echo "Building ${AREA} tiles with planetiler (this downloads the extract + builds)..."
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx3g" \
  -v "$(pwd)/tiles:/data" \
  ghcr.io/onthegomap/planetiler:latest \
  --download --area="${AREA}" --output=/data/gb.mbtiles --force

echo
echo "Done -> tiles/gb.mbtiles"
echo "Now: docker compose up -d dronefly-tiles   (then check: docker logs dronefly-tiles)"
