# Grillerei

Kleine Karten-Website, die öffentliche **Grillplätze, Feuerstellen, Picknick- und Rastplätze**
sowie **Schutzhütten** anzeigt. Die Daten kommen live aus OpenStreetMap (Overpass API),
die Karte startet auf der aktuellen GPS-Position.

## Funktionen

- **Startpunkt = GPS-Position.** Beim Laden wird `navigator.geolocation` abgefragt; bei
  Ablehnung oder Fehler zeigt die Karte Deutschland, und es kann per Ortssuche
  (Nominatim) navigiert werden. Der Button „Mein Standort“ wiederholt die Abfrage.
- **Live-Daten.** Beim Verschieben/Zoomen wird der sichtbare Ausschnitt bei Overpass
  abgefragt, entprellt. Ab Zoomstufe 11 aufwärts, darunter wäre die Abfrage zu groß.
- **Persistenter Cache** (siehe unten): bereits geladene Gebiete kommen beim Wiederbesuch
  ohne Netzwerk direkt auf die Karte.
- **Kategoriefilter** als Chips mit Trefferzahl; die Auswahl wird in `localStorage` gemerkt.
  Ein Filterwechsel kostet keine Anfrage – es werden immer alle Kategorien geladen und nur
  clientseitig gefiltert.
- **Seitenliste** aller Plätze im Ausschnitt, sortiert nach Entfernung zum eigenen Standort
  (oder zur Kartenmitte). Klick springt zum Marker und öffnet das Popup.
- **Popup** mit Ausstattung (Holz/Holzkohle, überdacht, Picknicktisch, WC, Trinkwasser,
  barrierefrei, Gebühr, Öffnungszeiten …), Routing-Link und Link zum OSM-Objekt.
- Marker-Clustering, Dark Mode und mobiles Layout sind enthalten.

## Abgefragte OSM-Tags

| Kategorie      | Tag |
| -------------- | --- |
| Grillplatz     | `amenity=bbq` |
| Feuerstelle    | `leisure=firepit` |
| Picknickplatz  | `tourism=picnic_site` |
| Rastplatz      | `highway=rest_area`, `highway=services` |
| Schutzhütte    | `amenity=shelter` + `shelter_type=picnic_shelter\|basic_hut\|weather_shelter\|lean_to` |

Anpassen in `app.js` → `CATEGORIES`.

## Cache

Die Welt ist in ein festes Kachelraster zerlegt (Slippy-Map-Kacheln auf Zoomstufe 12,
knapp 10 km Kantenlänge). Pro Kachel speichert `cache.js` in IndexedDB, wann sie zuletzt
geholt wurde und welche Plätze darin liegen.

Beim Laden eines Ausschnitts wird zuerst der Cache gezeichnet; nur die fehlenden oder
abgelaufenen Kacheln gehen als **ein** kachelbündiges Rechteck an Overpass. Die Abdeckung
ist dadurch über Sitzungen hinweg zusammensetzbar: ein bereits besuchtes Gebiet erzeugt
beim Wiederbesuch null Anfragen, ein Schwenk innerhalb geladener Kacheln ebenfalls.

- **Haltbarkeit:** 30 Tage (`CACHE_TTL_MS`), danach wird die Kachel neu geholt.
- **Auch leere Kacheln werden gespeichert** – „hier ist nichts“ ist ebenfalls ein Ergebnis.
- **Obergrenze:** 4000 Kacheln (`CACHE_MAX_TILES`, ~1,4 kB pro Kachel in dicht getaggten
  Gegenden); darüber werden die ältesten entfernt.
- Erreicht eine Antwort das Overpass-Limit (`RESULT_LIMIT`), ist sie abgeschnitten und wird
  bewusst **nicht** gecacht.
- Ohne IndexedDB (z. B. privater Modus) hält der Cache nur für die Sitzung, die Seite
  funktioniert unverändert. Der Zustand steht unten in der Seitenliste, dort lässt er sich
  auch leeren.

## Dateien

```
index.html                    Seitengerüst
style.css                     Layout, Light/Dark, Marker- und Popup-Stile
app.js                        Karte, Geolocation, Overpass-Abfrage, Filter, Liste
cache.js                      Kachelraster + IndexedDB-Cache der geladenen Plätze
vendor/                       Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 (BSD-2 / MIT)
.github/workflows/pages.yml   Deploy nach GitHub Pages
.nojekyll                     kein Jekyll-Processing bei Branch-Deployment
```

Bibliotheken aktualisieren (nur bei Bedarf, Versionen in den Dateiköpfen):

```bash
curl -sSfL -o vendor/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
curl -sSfL -o vendor/leaflet.js  https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
# … analog MarkerCluster.css, MarkerCluster.Default.css, leaflet.markercluster.js
# sowie vendor/images/{layers,layers-2x,marker-icon,marker-icon-2x,marker-shadow}.png
```

## Hinweise

- Die öffentliche Overpass-Instanz hat Rate-Limits. Bei Überlastung (429/504) wird
  automatisch auf `overpass.kumi.systems` bzw. `overpass.private.coffee` ausgewichen.
- OSM-Daten sind nutzergepflegt: fehlende Plätze lassen sich direkt auf
  [openstreetmap.org](https://www.openstreetmap.org) ergänzen.
- Kartenkacheln von tile.openstreetmap.org unterliegen der
  [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) – für eine
  öffentlich beworbene Seite besser einen eigenen Tile-Anbieter einsetzen.
