/* Gemeinsame Definition der Platzkategorien.

   Wird sowohl im Browser (als klassisches Script, definiert globale Konstanten)
   als auch im Build-Skript unter Node geladen (per require). Damit gibt es genau
   eine Quelle für Overpass-Filter, Klassifizierung und die Tags, die wir behalten. */

'use strict';

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

/* Reihenfolge = Priorität: ein Objekt mit mehreren passenden Tags bekommt die
   erste zutreffende Kategorie. */
function classify(tags) {
  if (tags.amenity === 'bbq') return 'bbq';
  if (tags.leisure === 'firepit') return 'firepit';
  if (tags.tourism === 'picnic_site') return 'picnic';
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'rest';
  if (tags.amenity === 'shelter') return 'shelter';
  return null;
}

/* Ausgewählte Tags, die für einen Grillabend tatsächlich relevant sind –
   samt Übersetzung der Werte fürs Popup. */
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

/* Nur diese Tags werden gespeichert und ausgeliefert. Die klassifizierenden Tags
   (amenity, leisure, …) fallen weg, ihre Information steckt schon in der Kategorie. */
const TAG_KEYS = [
  'name', 'description', 'opening_hours', 'capacity',
  ...DETAIL_TAGS.map(([key]) => key),
];

function trimTags(tags) {
  const out = {};
  for (const key of TAG_KEYS) if (tags[key] != null) out[key] = tags[key];
  return out;
}

/* Ein Overpass-Element auf den kompakten Datensatz reduzieren, den Cache und
   statische Kacheln verwenden. Gibt null zurück, wenn es nicht verwertbar ist. */
function toRecord(el) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const tags = el.tags || {};
  const category = classify(tags);
  if (!category) return null;

  return {
    i: `${el.type}/${el.id}`,
    c: category,
    y: Math.round(lat * 1e5) / 1e5,   // ~1 m genau, spart deutlich Platz
    x: Math.round(lon * 1e5) / 1e5,
    t: trimTags(tags),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { CATEGORIES, classify, DETAIL_TAGS, TAG_KEYS, trimTags, toRecord };
}
