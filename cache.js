/* Persistenter Cache für bereits geladene Plätze.

   Die Welt wird in ein festes Kachelraster (Slippy-Map-Kacheln, CACHE_ZOOM)
   zerlegt. Pro Kachel wird gespeichert, wann sie zuletzt von Overpass geholt
   wurde und welche Plätze darin liegen. Dadurch ist die Abdeckung über Sitzungen
   hinweg zusammensetzbar: Beim Wiederbesuch wird nur noch abgefragt, was fehlt
   oder veraltet ist.

   Ablage in IndexedDB (asynchron, kein 5-MB-Limit wie localStorage). Steht sie
   nicht zur Verfügung – z. B. privater Modus –, hält ein Fallback die Kacheln
   nur im Speicher; die Seite funktioniert dann wie vorher, nur ohne Persistenz. */

'use strict';

const CACHE_ZOOM = 10;                                  // ~39 km Kantenlänge
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;          // 30 Tage (nur Overpass-Kacheln)
const CACHE_MAX_TILES = 4000;                           // danach wird gejätet
const DB_NAME = 'grillerei';
const DB_VERSION = 2;                                   // 2: Raster auf Zoom 10 umgestellt
const STORE = 'tiles';

/* Eine Kachel ist frisch, wenn sie aus dem aktuellen Datenstand stammt.
   Kacheln aus dem statischen Build tragen dessen Zeitstempel in `b` und gelten
   genau so lange, wie der Build aktuell ist. Live von Overpass geholte Kacheln
   haben kein `b` und laufen nach der TTL ab. */
function isTileFresh(tile, now, build) {
  if (!tile) return false;
  if (tile.b) return tile.b === build;
  return now - tile.ts < CACHE_TTL_MS;
}

/* ------------------------------------------------------------- Kachelmathe */

const MAX_LAT = 85.0511287798;

const Tiles = {
  zoom: CACHE_ZOOM,

  x(lon) {
    const n = 2 ** CACHE_ZOOM;
    return Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
  },

  y(lat) {
    const n = 2 ** CACHE_ZOOM;
    const clamped = Math.min(MAX_LAT, Math.max(-MAX_LAT, lat));
    const rad = clamped * Math.PI / 180;
    const v = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  },

  lon(x) { return x / 2 ** CACHE_ZOOM * 360 - 180; },

  lat(y) {
    const n = Math.PI - 2 * Math.PI * y / 2 ** CACHE_ZOOM;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  },

  key(x, y) { return `${CACHE_ZOOM}/${x}/${y}`; },

  keyFor(lat, lon) { return Tiles.key(Tiles.x(lon), Tiles.y(lat)); },

  /* Alle Kacheln, die das Rechteck berühren. */
  cover(bounds) {
    const x0 = Tiles.x(bounds.getWest());
    const x1 = Tiles.x(bounds.getEast());
    const y0 = Tiles.y(bounds.getNorth());
    const y1 = Tiles.y(bounds.getSouth());
    const keys = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        keys.push(Tiles.key(x, y));
      }
    }
    return keys;
  },

  /* Kachelbündiges Rechteck um eine Menge von Kacheln – das ist die Bbox,
     die dann bei Overpass angefragt wird. */
  envelope(keys) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const k of keys) {
      const [, x, y] = k.split('/').map(Number);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return {
      keys: (() => {
        const all = [];
        for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) all.push(Tiles.key(x, y));
        return all;
      })(),
      south: Tiles.lat(maxY + 1),
      west: Tiles.lon(minX),
      north: Tiles.lat(minY),
      east: Tiles.lon(maxX + 1),
    };
  },
};

/* ------------------------------------------------------------- IndexedDB */

const TileCache = (() => {
  let dbPromise = null;
  const memory = new Map();   // Fallback, falls IndexedDB fehlt
  let usingMemory = false;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!self.indexedDB) { reject(new Error('IndexedDB nicht verfügbar')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Schemawechsel: alten Bestand verwerfen, er passt dann nicht mehr.
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        const store = db.createObjectStore(STORE, { keyPath: 'k' });
        store.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blockiert'));
    }).catch((err) => {
      usingMemory = true;
      console.warn('Grillerei: kein persistenter Cache –', err.message);
      return null;
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  return {
    get usingMemory() { return usingMemory; },

    /* Liefert Map<key, tile> nur für vorhandene Kacheln. */
    async get(keys) {
      const db = await open();
      const out = new Map();
      if (!db) {
        for (const k of keys) if (memory.has(k)) out.set(k, memory.get(k));
        return out;
      }
      return new Promise((resolve) => {
        const store = tx(db, 'readonly');
        let pending = keys.length;
        if (!pending) { resolve(out); return; }
        for (const k of keys) {
          const req = store.get(k);
          req.onsuccess = () => {
            if (req.result) out.set(k, req.result);
            if (--pending === 0) resolve(out);
          };
          req.onerror = () => { if (--pending === 0) resolve(out); };
        }
      });
    },

    async putMany(tiles) {
      const db = await open();
      if (!db) {
        for (const t of tiles) memory.set(t.k, t);
        return;
      }
      return new Promise((resolve) => {
        const trans = db.transaction(STORE, 'readwrite');
        const store = trans.objectStore(STORE);
        for (const t of tiles) store.put(t);
        trans.oncomplete = () => resolve();
        trans.onerror = () => resolve();   // Cache-Fehler dürfen die Karte nicht blockieren
        trans.onabort = () => resolve();
      });
    },

    async clear() {
      memory.clear();
      const db = await open();
      if (!db) return;
      return new Promise((resolve) => {
        const trans = db.transaction(STORE, 'readwrite');
        trans.objectStore(STORE).clear();
        trans.oncomplete = () => resolve();
        trans.onerror = () => resolve();
      });
    },

    async stats() {
      const db = await open();
      if (!db) return { tiles: memory.size, persistent: false };
      return new Promise((resolve) => {
        const store = tx(db, 'readonly');
        const req = store.count();
        req.onsuccess = () => resolve({ tiles: req.result, persistent: true });
        req.onerror = () => resolve({ tiles: 0, persistent: true });
      });
    },

    /* Älteste Kacheln entfernen, damit der Speicher nicht unbegrenzt wächst. */
    async prune() {
      const db = await open();
      if (!db) return 0;
      const { tiles } = await this.stats();
      const excess = tiles - CACHE_MAX_TILES;
      if (excess <= 0) return 0;
      return new Promise((resolve) => {
        const store = tx(db, 'readwrite');
        const cursorReq = store.index('ts').openCursor();
        let removed = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= excess) { resolve(removed); return; }
          cursor.delete();
          removed++;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve(removed);
      });
    },
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { Tiles, TileCache, CACHE_ZOOM, CACHE_TTL_MS, isTileFresh };
}
