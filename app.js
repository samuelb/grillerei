/* Grillerei – öffentliche Grill-, Feuer-, Picknick- und Rastplätze aus OpenStreetMap.
   Daten live via Overpass API, Kartenkacheln von OpenStreetMap. */

'use strict';

/* ------------------------------------------------------------------ Konfig */

const CATEGORIES = {
  bbq: {
    label: 'Grillplatz',
    emoji: '🔥',
    color: '#d9480f',
    filters: ['nwr["amenity"="bbq"]'],
  },
  firepit: {
    label: 'Feuerstelle',
    emoji: '🪵',
    color: '#a53a1c',
    filters: ['nwr["leisure"="firepit"]'],
  },
  picnic: {
    label: 'Picknickplatz',
    emoji: '🧺',
    color: '#2f7d4f',
    filters: ['nwr["tourism"="picnic_site"]'],
  },
  rest: {
    label: 'Rastplatz',
    emoji: '🅿️',
    color: '#2563eb',
    filters: ['nwr["highway"="rest_area"]', 'nwr["highway"="services"]'],
  },
  shelter: {
    label: 'Schutzhütte',
    emoji: '⛺',
    color: '#7c3aed',
    filters: ['nwr["amenity"="shelter"]["shelter_type"~"^(picnic_shelter|basic_hut|weather_shelter|lean_to)$"]'],
  },
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MIN_ZOOM_FOR_QUERY = 11;   // darunter wäre die Abfrage zu groß für Overpass
const RESULT_LIMIT = 800;        // pro Overpass-Abfrage
const LIST_LIMIT = 120;          // Einträge in der Seitenliste
const FALLBACK_VIEW = { center: [51.1, 10.4], zoom: 6 };  // Deutschland

/* ------------------------------------------------------------------- State */

const state = {
  features: new Map(),           // "node/123" -> feature
  markers: new Map(),            // "node/123" -> L.Marker
  clusters: {},                  // Kategorie -> L.MarkerClusterGroup
  enabled: loadEnabled(),
  fetched: {},                   // Kategorie -> Array<L.LatLngBounds>
  userPos: null,                 // L.LatLng
  endpoint: 0,
  request: null,                 // laufender AbortController
  debounce: null,
};

Object.keys(CATEGORIES).forEach((key) => { state.fetched[key] = []; });

/* --------------------------------------------------------------------- Map */

const map = L.map('map', {
  zoomControl: true,
  worldCopyJump: true,
}).setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
}).addTo(map);

L.control.scale({ imperial: false }).addTo(map);

for (const [key, cat] of Object.entries(CATEGORIES)) {
  const group = L.markerClusterGroup({
    maxClusterRadius: 45,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 17,
    iconCreateFunction: (cluster) => L.divIcon({
      html: `<div class="pin" style="background:${cat.color}"><span>${cluster.getChildCount()}</span></div>`,
      className: '',
      iconSize: null,
    }),
  });
  state.clusters[key] = group;
  if (state.enabled.has(key)) group.addTo(map);
}

/* ----------------------------------------------------------------- Filter-UI */

const filtersEl = document.getElementById('filters');

for (const [key, cat] of Object.entries(CATEGORIES)) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.style.setProperty('--chip-color', cat.color);
  chip.setAttribute('aria-pressed', String(state.enabled.has(key)));
  chip.dataset.cat = key;
  chip.innerHTML = `<i class="dot"></i>${cat.emoji} ${cat.label} <span class="count" data-count="${key}"></span>`;
  chip.addEventListener('click', () => toggleCategory(key, chip));
  filtersEl.appendChild(chip);
}

function toggleCategory(key, chip) {
  if (state.enabled.has(key)) {
    state.enabled.delete(key);
    map.removeLayer(state.clusters[key]);
  } else {
    state.enabled.add(key);
    state.clusters[key].addTo(map);
  }
  chip.setAttribute('aria-pressed', String(state.enabled.has(key)));
  saveEnabled();
  renderList();
  scheduleLoad(0);
}

function loadEnabled() {
  try {
    const raw = JSON.parse(localStorage.getItem('grillerei.categories'));
    if (Array.isArray(raw) && raw.length) {
      return new Set(raw.filter((k) => k in CATEGORIES));
    }
  } catch (_) { /* Voreinstellung nutzen */ }
  return new Set(Object.keys(CATEGORIES));
}

function saveEnabled() {
  try {
    localStorage.setItem('grillerei.categories', JSON.stringify([...state.enabled]));
  } catch (_) { /* z. B. privater Modus – nicht kritisch */ }
}

/* -------------------------------------------------------------- Standort */

const locateBtn = document.getElementById('locateBtn');
locateBtn.addEventListener('click', () => locate(true));

let userMarker = null;
let accuracyCircle = null;

function locate(userInitiated) {
  if (!navigator.geolocation) {
    if (userInitiated) showStatus('Dieser Browser unterstützt keine Standortabfrage.', 'error');
    return;
  }
  showStatus('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      state.userPos = L.latLng(latitude, longitude);

      if (userMarker) map.removeLayer(userMarker);
      if (accuracyCircle) map.removeLayer(accuracyCircle);

      accuracyCircle = L.circle(state.userPos, {
        radius: Math.max(accuracy || 0, 15),
        color: '#1d74f5', weight: 1, fillOpacity: 0.1,
      }).addTo(map);

      userMarker = L.marker(state.userPos, {
        icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: null }),
        zIndexOffset: 1000,
        title: 'Dein Standort',
      }).addTo(map);

      map.setView(state.userPos, Math.max(map.getZoom(), 14));
      hideStatus();
    },
    (err) => {
      const msg = err.code === err.PERMISSION_DENIED
        ? 'Standortzugriff abgelehnt – bitte oben einen Ort suchen.'
        : 'Standort nicht verfügbar – bitte oben einen Ort suchen.';
      showStatus(msg, 'error', 6000);
      if (!userInitiated) map.setView(FALLBACK_VIEW.center, FALLBACK_VIEW.zoom);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

/* ---------------------------------------------------------------- Ortssuche */

document.getElementById('searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  showStatus('Suche Ort …');
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status);
    const hits = await res.json();
    if (!hits.length) { showStatus(`Kein Treffer für „${q}“.`, 'error', 4000); return; }

    const hit = hits[0];
    if (hit.boundingbox) {
      const [s, n, w, e] = hit.boundingbox.map(Number);
      map.fitBounds([[s, w], [n, e]], { maxZoom: 15 });
    } else {
      map.setView([Number(hit.lat), Number(hit.lon)], 14);
    }
    hideStatus();
  } catch (_) {
    showStatus('Ortssuche gerade nicht erreichbar.', 'error', 4000);
  }
});

/* ------------------------------------------------------- Overpass-Abfrage */

map.on('moveend zoomend', () => scheduleLoad());

function scheduleLoad(delay = 500) {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(loadVisible, delay);
}

async function loadVisible() {
  if (!state.enabled.size) { hideStatus(); renderList(); return; }

  if (map.getZoom() < MIN_ZOOM_FOR_QUERY) {
    showStatus('Weiter hineinzoomen, um Plätze zu laden.');
    renderList();
    return;
  }

  // Etwas über den Bildschirmrand hinaus laden, damit kurzes Verschieben nichts nachlädt.
  const bounds = map.getBounds().pad(0.25);
  const missing = [...state.enabled].filter(
    (key) => !state.fetched[key].some((b) => b.contains(bounds)),
  );

  if (!missing.length) { hideStatus(); renderList(); return; }

  if (state.request) state.request.abort();
  const controller = new AbortController();
  state.request = controller;
  const timer = setTimeout(() => controller.abort(), 35000);
  showStatus('Plätze werden geladen …');

  try {
    const data = await queryOverpass(buildQuery(missing, bounds), controller.signal);
    missing.forEach((key) => rememberFetched(key, bounds));
    ingest(data.elements || []);
    hideStatus();
  } catch (err) {
    if (err.name !== 'AbortError') {
      showStatus('Overpass antwortet gerade nicht – später erneut versuchen.', 'error', 6000);
    }
  } finally {
    clearTimeout(timer);
    if (state.request === controller) state.request = null;
    renderList();
  }
}

function buildQuery(categories, bounds) {
  const bbox = [
    bounds.getSouth().toFixed(6),
    bounds.getWest().toFixed(6),
    bounds.getNorth().toFixed(6),
    bounds.getEast().toFixed(6),
  ].join(',');

  const parts = categories
    .flatMap((key) => CATEGORIES[key].filters)
    .map((f) => `  ${f}(${bbox});`)
    .join('\n');

  return `[out:json][timeout:30];\n(\n${parts}\n);\nout center ${RESULT_LIMIT};`;
}

async function queryOverpass(query, signal) {
  let lastError;
  // Bei Überlastung (429/504) den nächsten Spiegel probieren.
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[(state.endpoint + attempt) % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.endpoint = (state.endpoint + attempt) % OVERPASS_ENDPOINTS.length;
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass nicht erreichbar');
}

function rememberFetched(key, bounds) {
  const list = state.fetched[key];
  list.unshift(bounds);
  if (list.length > 40) list.length = 40;
}

/* ------------------------------------------------------- Ergebnisse einbauen */

function ingest(elements) {
  for (const el of elements) {
    const id = `${el.type}/${el.id}`;
    if (state.features.has(id)) continue;

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const tags = el.tags || {};
    const category = classify(tags);
    if (!category) continue;

    const feature = {
      id,
      type: el.type,
      osmId: el.id,
      category,
      latlng: L.latLng(lat, lon),
      name: tags.name || CATEGORIES[category].label,
      unnamed: !tags.name,
      tags,
    };

    state.features.set(id, feature);
    const marker = createMarker(feature);
    state.markers.set(id, marker);
    state.clusters[category].addLayer(marker);
  }
  updateCounts();
}

function classify(tags) {
  if (tags.amenity === 'bbq') return 'bbq';
  if (tags.leisure === 'firepit') return 'firepit';
  if (tags.tourism === 'picnic_site') return 'picnic';
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'rest';
  if (tags.amenity === 'shelter') return 'shelter';
  return null;
}

function createMarker(feature) {
  const cat = CATEGORIES[feature.category];
  const marker = L.marker(feature.latlng, {
    icon: L.divIcon({
      className: '',
      html: `<div class="pin" style="background:${cat.color}"><span>${cat.emoji}</span></div>`,
      iconSize: null,
    }),
    title: feature.name,
  });
  marker.bindPopup(() => popupHtml(feature), { maxWidth: 280 });
  return marker;
}

/* Ausgewählte Tags, die für einen Grillabend tatsächlich relevant sind. */
const DETAIL_TAGS = [
  ['fuel', { wood: 'Holz', charcoal: 'Holzkohle', gas: 'Gas', electric: 'Strom' }],
  ['covered', { yes: 'überdacht' }],
  ['fireplace', { yes: 'Feuerstelle' }],
  ['picnic_table', { yes: 'Picknicktisch' }],
  ['toilets', { yes: 'WC' }],
  ['drinking_water', { yes: 'Trinkwasser' }],
  ['waste_basket', { yes: 'Abfalleimer' }],
  ['wheelchair', { yes: 'barrierefrei', limited: 'teilw. barrierefrei' }],
  ['fee', { no: 'kostenlos', yes: 'gebührenpflichtig' }],
  ['access', { permissive: 'geduldet', private: 'privat', customers: 'nur Gäste' }],
  ['reservation', { required: 'Reservierung nötig' }],
];

function popupHtml(feature) {
  const { tags, latlng } = feature;
  const chips = [];

  for (const [key, values] of DETAIL_TAGS) {
    const raw = tags[key];
    if (!raw) continue;
    for (const part of raw.split(';')) {
      const label = values[part.trim()];
      if (label) chips.push(label);
    }
  }
  if (tags.opening_hours) chips.push(tags.opening_hours);
  if (tags.capacity) chips.push(`${tags.capacity} Plätze`);

  const el = document.createElement('div');
  el.innerHTML = `
    <p class="pop-title"></p>
    <p class="pop-kind"></p>
    <div class="pop-tags"></div>
    <p class="pop-note muted"></p>
    <div class="pop-links">
      <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${latlng.lat},${latlng.lng}">Route</a>
      <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/${feature.type}/${feature.osmId}">OSM</a>
    </div>`;

  el.querySelector('.pop-title').textContent = feature.name;
  el.querySelector('.pop-kind').textContent = CATEGORIES[feature.category].label;
  const tagBox = el.querySelector('.pop-tags');
  for (const chip of chips) {
    const s = document.createElement('span');
    s.textContent = chip;
    tagBox.appendChild(s);
  }
  const note = el.querySelector('.pop-note');
  if (tags.description) note.textContent = tags.description; else note.remove();

  return el;
}

function updateCounts() {
  const tally = {};
  for (const f of state.features.values()) tally[f.category] = (tally[f.category] || 0) + 1;
  for (const key of Object.keys(CATEGORIES)) {
    const el = filtersEl.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = tally[key] ? String(tally[key]) : '';
  }
}

/* ----------------------------------------------------------------- Liste */

const sidebar = document.getElementById('sidebar');
const listEl = document.getElementById('resultList');
const countEl = document.getElementById('resultCount');
const hintEl = document.getElementById('resultHint');
const listToggle = document.getElementById('listToggle');

listToggle.addEventListener('click', () => {
  const open = sidebar.hasAttribute('hidden');
  sidebar.toggleAttribute('hidden', !open);
  listToggle.setAttribute('aria-expanded', String(open));
  map.invalidateSize();
});

function renderList() {
  const bounds = map.getBounds();
  const ref = state.userPos || map.getCenter();

  const visible = [...state.features.values()]
    .filter((f) => state.enabled.has(f.category) && bounds.contains(f.latlng))
    .map((f) => ({ f, dist: ref.distanceTo(f.latlng) }))
    .sort((a, b) => a.dist - b.dist);

  countEl.textContent = visible.length
    ? `${visible.length} ${visible.length === 1 ? 'Platz' : 'Plätze'} im Kartenausschnitt`
    : 'Keine Plätze im Kartenausschnitt';
  hintEl.textContent = state.userPos
    ? 'Entfernung ab deinem Standort'
    : 'Entfernung ab Kartenmitte';

  listEl.replaceChildren();

  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = map.getZoom() < MIN_ZOOM_FOR_QUERY
      ? 'Zoome näher heran, damit Plätze geladen werden.'
      : 'Hier ist nichts eingetragen – verschiebe die Karte oder ergänze den Platz auf openstreetmap.org.';
    listEl.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { f, dist } of visible.slice(0, LIST_LIMIT)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `
      <span class="result-icon">${CATEGORIES[f.category].emoji}</span>
      <span class="result-body">
        <span class="result-name"></span>
        <span class="result-meta"></span>
      </span>
      <span class="result-dist">${formatDistance(dist)}</span>`;
    btn.querySelector('.result-name').textContent = f.name;
    btn.querySelector('.result-meta').textContent = f.unnamed
      ? 'ohne Namen'
      : CATEGORIES[f.category].label;
    btn.addEventListener('click', () => focusFeature(f));
    li.appendChild(btn);
    frag.appendChild(li);
  }
  listEl.appendChild(frag);
}

function focusFeature(feature) {
  const marker = state.markers.get(feature.id);
  if (!marker) return;
  // zoomToShowLayer zoomt so weit hinein, bis der Marker nicht mehr geclustert ist.
  state.clusters[feature.category].zoomToShowLayer(marker, () => {
    map.panTo(feature.latlng);
    marker.openPopup();
  });
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 1000)} km`;
}

/* ---------------------------------------------------------------- Status */

let statusTimer = null;
const statusEl = document.getElementById('status');

function showStatus(text, kind = '', autoHide = 0) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
  statusEl.hidden = false;
  if (autoHide) statusTimer = setTimeout(hideStatus, autoHide);
}

function hideStatus() {
  clearTimeout(statusTimer);
  statusEl.hidden = true;
}

/* ------------------------------------------------------------------ Start */

locate(false);
scheduleLoad(300);
