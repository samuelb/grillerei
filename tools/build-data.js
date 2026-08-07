#!/usr/bin/env node
/* Erzeugt die statischen Platz-Kacheln unter data/.

   Der Abdeckungsbereich wird in kachelbündige Blöcke zerlegt und Block für Block
   bei Overpass abgefragt – eine einzelne Abfrage über ganz DACH würde ins Timeout
   laufen. Weil jeder Block vollständig abgefragt wird, ist die Abdeckung exakt
   bekannt: Alle Kacheln der Blöcke landen im Manifest, auch die leeren. Der
   Client weiß dadurch, wo er statisch ausliefern kann und wo er auf Overpass
   zurückfallen muss.

   Aufruf:  node tools/build-data.js [--chunks N] [--out data]
   Env:     GRILLEREI_BBOX="süd,west,nord,ost"   überschreibt den Bereich

   Ausgabe: data/index.json          Manifest: Kachel -> Anzahl Plätze
            data/{z}/{x}/{y}.json    Plätze der Kachel (nur wenn nicht leer) */

'use strict';

const fs = require('fs');
const path = require('path');
const { CATEGORIES, toRecord } = require('../categories.js');
const { Tiles, CACHE_ZOOM } = require('../cache.js');

/* Bounding-Box über Deutschland, Österreich und die Schweiz. Bewusst ein
   Rechteck und keine Ländergrenzen: so sind auch Grenzkacheln vollständig. */
const DEFAULT_BBOX = { south: 45.7, west: 5.7, north: 55.2, east: 17.3 };

const CHUNK_TILES = 8;              // Kacheln je Blockkante
const REQUEST_PAUSE_MS = 8000;      // Pause zwischen Blöcken, Overpass zuliebe
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 300000;
const RESULT_LIMIT = 20000;
const CHUNK_CACHE_DIR = '.overpass-chunks';
const CHUNK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const USER_AGENT = 'grillerei-build/1.0 (+https://github.com/samuelb/grillerei)';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { out: 'data', chunks: null, cacheDir: CHUNK_CACHE_DIR };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--chunks') args.chunks = Number(argv[++i]);
    else if (argv[i] === '--cache-dir') args.cacheDir = argv[++i];
  }
  return args;
}

function bboxFromEnv() {
  const raw = process.env.GRILLEREI_BBOX;
  if (!raw) return DEFAULT_BBOX;
  const [south, west, north, east] = raw.split(',').map(Number);
  if ([south, west, north, east].some(Number.isNaN)) {
    throw new Error(`GRILLEREI_BBOX unlesbar: ${raw}`);
  }
  return { south, west, north, east };
}

/* Den Bereich in kachelbündige Blöcke zerlegen. */
function chunksFor(bbox) {
  const x0 = Tiles.x(bbox.west), x1 = Tiles.x(bbox.east);
  const y0 = Tiles.y(bbox.north), y1 = Tiles.y(bbox.south);
  const chunks = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += CHUNK_TILES) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += CHUNK_TILES) {
      const xEnd = Math.min(x + CHUNK_TILES - 1, Math.max(x0, x1));
      const yEnd = Math.min(y + CHUNK_TILES - 1, Math.max(y0, y1));
      const keys = [];
      for (let tx = x; tx <= xEnd; tx++) for (let ty = y; ty <= yEnd; ty++) keys.push(Tiles.key(tx, ty));
      chunks.push({
        keys,
        south: Tiles.lat(yEnd + 1),
        west: Tiles.lon(x),
        north: Tiles.lat(y),
        east: Tiles.lon(xEnd + 1),
      });
    }
  }
  return chunks;
}

function buildQuery(chunk) {
  const bbox = [chunk.south, chunk.west, chunk.north, chunk.east]
    .map((v) => v.toFixed(6)).join(',');
  const parts = Object.values(CATEGORIES)
    .flatMap((cat) => cat.filters)
    .map((f) => `  ${f}(${bbox});`)
    .join('\n');
  return `[out:json][timeout:180];\n(\n${parts}\n);\nout center ${RESULT_LIMIT};`;
}

/* Wie lange bis zum nächsten freien Slot? Overpass verrät das selbst, das ist
   deutlich zielgenauer als blindes Backoff. */
async function slotWaitMs(endpoint) {
  try {
    const res = await fetch(`${endpoint.replace(/interpreter$/, 'status')}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (/slots? available now/.test(text)) return 0;
    const waits = [...text.matchAll(/in (\d+) seconds/g)].map((m) => Number(m[1]));
    return waits.length ? (Math.min(...waits) + 2) * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchChunk(chunk, index, total) {
  const query = buildQuery(chunk);
  const label = `[${index + 1}/${total}]`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    let retryAfterMs = null;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // Ohne erkennbaren User-Agent antwortet overpass-api.de mit 406.
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(300000),
      });

      if (res.status === 429) {
        retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || await slotWaitMs(endpoint);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const elements = data.elements || [];
      if (elements.length >= RESULT_LIMIT) {
        throw new Error(`Overpass-Limit erreicht (${elements.length}) – Block zu groß`);
      }
      console.log(`  ${label} ${elements.length} Objekte  (${endpoint.split('/')[2]})`);
      return elements;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`  ${label} Versuch ${attempt} fehlgeschlagen: ${err.message}`);
        throw err;
      }
      const wait = retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
      console.warn(`  ${label} Versuch ${attempt} fehlgeschlagen: ${err.message} – erneut in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

/* Erfolgreiche Blöcke liegen auf der Platte. Die Action hebt das Verzeichnis in
   den Actions-Cache, damit ein erneuter Lauf nur die fehlenden Blöcke holt –
   sonst wären 20 gelungene Abfragen wegen eines einzigen Ausreißers verloren. */
function chunkCachePath(dir, chunk) {
  return path.join(dir, `${chunk.keys[0].replace(/\//g, '-')}.json`);
}

function readChunkCache(dir, chunk) {
  const file = chunkCachePath(dir, chunk);
  if (!fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - entry.ts > CHUNK_MAX_AGE_MS) return null;
    return entry.elements;
  } catch {
    return null;
  }
}

function writeChunkCache(dir, chunk, elements) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chunkCachePath(dir, chunk), JSON.stringify({ ts: Date.now(), elements }));
}

async function main() {
  const args = parseArgs(process.argv);
  const bbox = bboxFromEnv();
  let chunks = chunksFor(bbox);
  if (args.chunks) chunks = chunks.slice(0, args.chunks);

  const tileCount = chunks.reduce((n, c) => n + c.keys.length, 0);
  console.log(`Bereich: ${JSON.stringify(bbox)}`);
  console.log(`Zoom ${CACHE_ZOOM}: ${tileCount} Kacheln in ${chunks.length} Blöcken\n`);

  const byTile = new Map();
  for (const chunk of chunks) for (const key of chunk.keys) byTile.set(key, []);

  const seen = new Set();
  let skipped = 0, fetched = 0, reused = 0;

  for (const [index, chunk] of chunks.entries()) {
    let records = readChunkCache(args.cacheDir, chunk);

    if (records) {
      reused++;
      console.log(`  [${index + 1}/${chunks.length}] ${records.length} Plätze aus Zwischenspeicher`);
    } else {
      const elements = await fetchChunk(chunk, index, chunks.length);
      records = [];
      for (const el of elements) {
        const record = toRecord(el);
        if (record) records.push(record); else skipped++;
      }
      writeChunkCache(args.cacheDir, chunk, records);
      fetched++;
      if (index < chunks.length - 1) await sleep(REQUEST_PAUSE_MS);
    }

    for (const record of records) {
      if (seen.has(record.i)) continue;      // Blockränder können überlappen
      const bucket = byTile.get(Tiles.keyFor(record.y, record.x));
      if (!bucket) continue;                 // außerhalb des Bereichs
      seen.add(record.i);
      bucket.push(record);
    }
  }

  /* Schreiben. data/ wird vorher geleert, damit verschwundene Kacheln nicht
     als Leichen liegen bleiben. */
  const outDir = path.resolve(args.out);
  fs.rmSync(outDir, { recursive: true, force: true });

  const manifest = { zoom: CACHE_ZOOM, built: new Date().toISOString(), bbox, tiles: {} };
  let written = 0, total = 0;

  for (const [key, records] of [...byTile].sort(([a], [b]) => a.localeCompare(b))) {
    manifest.tiles[key] = records.length;
    total += records.length;
    if (!records.length) continue;           // leere Kachel: nur im Manifest

    records.sort((a, b) => a.i.localeCompare(b.i));   // stabile Reihenfolge -> stabile Diffs
    const file = path.join(outDir, `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records));
    written++;
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(manifest));

  const bytes = execSize(outDir);
  const size = bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`;

  console.log(`\n${chunks.length} Blöcke: ${fetched} abgefragt, ${reused} aus Zwischenspeicher`);
  console.log(`${total} Plätze in ${written} Kacheln (${byTile.size - written} leer)`);
  if (skipped) console.log(`${skipped} Objekte ohne Koordinate oder Kategorie übersprungen`);
  console.log(`Ausgabe: ${outDir} – ${size}`);
}

function execSize(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
  }
  return bytes;
}

main().catch((err) => {
  console.error(`\nBuild fehlgeschlagen: ${err.message}`);
  process.exit(1);
});
