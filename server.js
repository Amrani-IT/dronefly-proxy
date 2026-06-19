// DroneFly data proxy — small, cached, CORS-clean gateway to the community
// data sources that block Cloudflare Workers / browser CORS (adsb.lol, Overpass).
// Run on a normal server IP (homelab/VPS). Node 20+ (built-in fetch).
import http from 'node:http';

const PORT = process.env.PORT || 8092;
const UA = 'DroneFly/1.0 (+https://dronefly.uk)';
const cache = new Map(); // key -> { exp, body }

function getCached(key) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.body;
  return null;
}
function setCached(key, body, ttlMs) { cache.set(key, { exp: Date.now() + ttlMs, body }); }

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=30'
  });
  res.end(JSON.stringify(obj));
}

async function getTraffic(lat, lon) {
  const key = `t:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const c = getCached(key); if (c) return c;
  let out = { ac: [] };
  try {
    const r = await fetch(`https://api.adsb.lol/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/5`, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    out = { ac: (d.ac || []).map(a => ({ lat: a.lat, lon: a.lon, alt_baro: a.alt_baro })) };
  } catch (_) {}
  setCached(key, out, 20000); // 20s
  return out;
}

async function getAirports(lat, lon, radius) {
  const key = `a:${lat.toFixed(2)},${lon.toFixed(2)},${radius}`;
  const c = getCached(key); if (c) return c;
  const q = `[out:json][timeout:25];(`
    + `node["aeroway"="aerodrome"](around:${radius},${lat},${lon});`
    + `way["aeroway"="aerodrome"](around:${radius},${lat},${lon});`
    + `node["aeroway"="heliport"](around:${radius},${lat},${lon});`
    + `way["aeroway"="heliport"](around:${radius},${lat},${lon}););out center 100;`;
  let out = { airports: [] };
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(q)
    });
    const d = await r.json();
    out = {
      airports: (d.elements || []).map(el => {
        const la = el.lat ?? (el.center && el.center.lat);
        const lo = el.lon ?? (el.center && el.center.lon);
        if (la == null) return null;
        const heli = el.tags && el.tags.aeroway === 'heliport';
        return { lat: la, lon: lo, heli, name: (el.tags && el.tags.name) || (heli ? 'Heliport' : 'Aerodrome') };
      }).filter(Boolean)
    };
  } catch (_) {}
  setCached(key, out, 3600000); // 1h
  return out;
}

async function getTLE() {
  const c = getCached('tle'); if (c) return c;
  let out = { sats: [] };
  try {
    const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=gnss&FORMAT=tle', { headers: { 'User-Agent': UA } });
    const txt = await r.text();
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
    const sats = [];
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = (lines[i] || '').trim();
      const l1 = lines[i + 1] || '';
      const l2 = lines[i + 2] || '';
      if (l1.startsWith('1 ') && l2.startsWith('2 ')) sats.push({ name, l1, l2 });
    }
    if (sats.length) out = { sats };
  } catch (_) {}
  setCached('tle', out, 21600000); // 6h
  return out;
}

// Controlled airspace / restricted zones from OpenAIP. Needs OPENAIP_KEY in the
// environment (free key from openaip.net). Returns simplified polygons.
async function getAirspace(lat, lon, dist) {
  const key = process.env.OPENAIP_KEY;
  if (!key) return { airspaces: [], note: 'no_key' };
  const ck = `as:${lat.toFixed(2)},${lon.toFixed(2)},${dist}`;
  const c = getCached(ck); if (c) return c;
  const dLat = dist / 111000;
  const dLon = dist / (111000 * Math.cos(lat * Math.PI / 180) || 1);
  const bbox = `${(lon - dLon).toFixed(4)},${(lat - dLat).toFixed(4)},${(lon + dLon).toFixed(4)},${(lat + dLat).toFixed(4)}`;
  let out = { airspaces: [] };
  try {
    const r = await fetch(`https://api.core.openaip.net/api/airspaces?bbox=${bbox}&limit=200`, {
      headers: { 'x-openaip-api-key': key, 'User-Agent': UA }
    });
    const d = await r.json();
    const items = d.items || d || [];
    out = {
      airspaces: items.map(a => {
        const g = a.geometry;
        if (!g || g.type !== 'Polygon' || !g.coordinates || !g.coordinates[0]) return null;
        const ring = g.coordinates[0].map(p => [p[1], p[0]]); // [lat,lon]
        return {
          name: a.name || 'Airspace',
          icaoClass: a.icaoClass, type: a.type,
          lower: a.lowerLimit && a.lowerLimit.value, upper: a.upperLimit && a.upperLimit.value,
          ring
        };
      }).filter(Boolean)
    };
  } catch (_) {}
  setCached(ck, out, 3600000); // 1h
  return out;
}

async function getKp() {
  const c = getCached('kp'); if (c) return c;
  let out = { kp: null };
  try {
    const r = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { headers: { 'User-Agent': UA } });
    const d = await r.json();
    for (let i = d.length - 1; i >= 0; i--) {
      const row = d[i];
      const v = parseFloat(Array.isArray(row) ? row[1] : (row.Kp ?? row.kp ?? row.kp_index));
      if (!isNaN(v)) { out = { kp: v }; break; }
    }
  } catch (_) {}
  setCached('kp', out, 300000); // 5m
  return out;
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  const u = new URL(req.url, 'http://x');
  const lat = parseFloat(u.searchParams.get('lat'));
  const lon = parseFloat(u.searchParams.get('lon'));
  try {
    if (u.pathname === '/health') return send(res, 200, { ok: true, time: new Date().toISOString() });
    if (u.pathname === '/kp') return send(res, 200, await getKp());
    if (u.pathname === '/tle') return send(res, 200, await getTLE());
    if (u.pathname === '/airspace') {
      if (isNaN(lat) || isNaN(lon)) return send(res, 400, { error: 'lat/lon required' });
      const dist = Math.min(parseInt(u.searchParams.get('dist') || '15000', 10), 40000);
      return send(res, 200, await getAirspace(lat, lon, dist));
    }
    if (u.pathname === '/traffic') {
      if (isNaN(lat) || isNaN(lon)) return send(res, 400, { error: 'lat/lon required' });
      return send(res, 200, await getTraffic(lat, lon));
    }
    if (u.pathname === '/airports') {
      if (isNaN(lat) || isNaN(lon)) return send(res, 400, { error: 'lat/lon required' });
      const radius = Math.min(parseInt(u.searchParams.get('dist') || '8000', 10), 40000);
      return send(res, 200, await getAirports(lat, lon, radius));
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: 'proxy error' });
  }
}).listen(PORT, () => console.log('dronefly-proxy on :' + PORT));
