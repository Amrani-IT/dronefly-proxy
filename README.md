# dronefly-proxy

Cached, CORS-clean backend for the DroneFly app. Two services in one stack:

- **dronefly-proxy** (`:8092`) — fetches community data server-side and adds CORS:
  - `/health`
  - `/traffic?lat=&lon=` — nearby aircraft (adsb.lol)
  - `/airports?lat=&lon=&dist=` — aerodromes/heliports (Overpass)
  - `/kp` — geomagnetic Kp (NOAA SWPC)
  - `/tle` — GNSS satellite elements (CelesTrak) for the GPS Satellites tile
- **dronefly-tiles** (`:8093`) — self-hosted map tiles (TileServer GL) from a
  Great Britain OpenMapTiles `.mbtiles`.

Both run on the `dronefly-proxy_default` docker network alongside the existing
`cloudflared` container, so one Cloudflare Tunnel routes both hostnames.

## Deploy / update on the VPS

```
cd /opt/dronefly-proxy
git pull

# one-time (and whenever you want fresh map data): build the GB tileset
./build-tiles.sh            # writes tiles/gb.mbtiles via planetiler (~few min, needs ~3GB RAM)

docker compose up -d --build
docker logs --tail 20 dronefly-tiles   # note the style name it serves, e.g. "basic-preview"
```

Verify:
```
curl -s https://api.dronefly.uk/tle | head -c 80      # {"sats":[...]}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8093/   # 200
```

## Cloudflare Tunnel hostnames (dronefly tunnel)
- `api.dronefly.uk`   -> `http://dronefly-proxy:8092`  (already set)
- `tiles.dronefly.uk` -> `http://dronefly-tiles:8093`  (add this for self-hosted maps)

## Point the app at self-hosted tiles (no rebuild needed)
In `dronefly/www/config.js`:
```js
window.DF_TILE_URL  = 'https://tiles.dronefly.uk/styles/<style-name>/{z}/{x}/{y}.png';
window.DF_TILE_ATTR = '© OpenMapTiles © OpenStreetMap';
```
`<style-name>` is whatever `docker logs dronefly-tiles` reports. Redeploy the web.
Leave `DF_TILE_URL` empty to stay on public OpenStreetMap tiles.
