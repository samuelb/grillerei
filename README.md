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

## Woher die Daten kommen

Die Welt ist in ein festes Kachelraster zerlegt (Slippy-Map-Kacheln auf Zoomstufe 10,
knapp 40 km Kantenlänge). Alles – vorgenerierte Dateien, Laufzeit-Cache, Overpass-Abfragen –
benutzt dasselbe Raster. Eine Kachel wird aus der ersten Quelle bedient, die sie hat:

1. **IndexedDB-Cache** (`cache.js`) – bereits geladene Kacheln, ohne Netzwerk.
2. **Vorgenerierte Kacheln** unter `data/` – für DACH von einer GitHub Action gebaut und
   von Pages ausgeliefert. Ein CDN-Abruf, typisch einige zehn Millisekunden.
3. **Overpass live** – nur außerhalb des vorgebauten Gebiets. Die fehlenden Kacheln gehen
   als **ein** kachelbündiges Rechteck raus.

Weil Quelle 2 keine Rate-Limits kennt, darf die Karte im vorgebauten Gebiet weiter
herausgezoomt sein (`MIN_ZOOM_STATIC` 9 statt `MIN_ZOOM_LIVE` 11).

### Vorgenerierte Kacheln

`tools/build-data.js` zerlegt den Bereich in kachelbündige Blöcke und fragt Block für Block
bei Overpass ab – eine einzelne Abfrage über ganz DACH liefe ins Timeout. Weil jeder Block
vollständig abgefragt wird, ist die Abdeckung exakt bekannt; **alle** Kacheln landen im
Manifest, auch die leeren.

```
data/index.json        { zoom, built, bbox, tiles: { "10/549/335": 130, … } }
data/10/549/335.json   [ { i, c, y, x, t }, … ]     nur wenn nicht leer
```

Der Bereich ist bewusst ein Rechteck über DE/AT/CH und keine Ländergrenze – so sind auch
Grenzkacheln vollständig. Anpassen über `DEFAULT_BBOX` im Skript oder `GRILLEREI_BBOX`:

```bash
GRILLEREI_BBOX="52.40,13.20,52.60,13.50" node tools/build-data.js --out data
```

Gebaut wird von `.github/workflows/data.yml`: montags per Cron und manuell per
*workflow_dispatch* (dort lässt sich die Bbox überschreiben). Geänderte Kacheln werden
committet, danach stößt der Workflow das Pages-Deployment an (ein Push mit dem
`GITHUB_TOKEN` löst selbst keine `on: push`-Workflows aus – daher der `workflow_run`-
Trigger in `pages.yml`).

Stand des ersten Builds: **119.150 Plätze in 1496 Kacheln, 9,1 MB**, Manifest 24 kB.
Pro Lauf ändern sich nur einzelne Kacheln.

Overpass ist unter Last unzuverlässig – der erste vollständige Lauf brauchte 30 Abfragen
und 24 Fehlversuche (429/502/504). Deshalb:

- 8 Versuche je Block mit exponentiellem Backoff bis 5 min, `Retry-After` wird beachtet,
  bei 429 fragt der Build `/api/status` und wartet gezielt auf den freien Slot.
- Erfolgreiche Blöcke landen in `.overpass-chunks` und werden von der Action über Läufe
  hinweg gecacht (3 Tage haltbar). Ein Neustart nach einem Fehlschlag holt nur, was fehlt –
  aus dem Zwischenspeicher läuft der komplette Build in unter einer Minute.
- Kachelt eine Antwort ans Overpass-Limit, bricht der Build ab, statt einen unvollständigen
  Datenstand zu veröffentlichen.

Ändern sich Filter oder Klassifizierung in `categories.js`, muss der Zwischenspeicher
verworfen werden – er enthält bereits klassifizierte Datensätze.

### Laufzeit-Cache

- **Statische Kacheln** tragen den Build-Zeitstempel und gelten genau so lange, wie dieser
  Build aktuell ist – ein neuer Build ersetzt sie automatisch.
- **Overpass-Kacheln** laufen nach 30 Tagen ab (`CACHE_TTL_MS`).
- **Auch leere Kacheln werden gespeichert** – „hier ist nichts“ ist ebenfalls ein Ergebnis.
- **Obergrenze:** 4000 Kacheln (`CACHE_MAX_TILES`); darüber werden die ältesten entfernt.
- Erreicht eine Live-Antwort das Overpass-Limit (`RESULT_LIMIT`), ist sie abgeschnitten und
  wird bewusst **nicht** gecacht.
- Ohne IndexedDB (z. B. privater Modus) hält der Cache nur für die Sitzung, die Seite
  funktioniert unverändert. Der Zustand steht unten in der Seitenliste, dort lässt er sich
  auch leeren.

## Dateien

```
index.html                    Seitengerüst
style.css                     Layout, Light/Dark, Marker- und Popup-Stile
categories.js                 Kategorien, Overpass-Filter, Klassifizierung  (Browser + Build)
app.js                        Karte, Geolocation, Datenquellen, Filter, Liste
cache.js                      Kachelraster + IndexedDB-Cache  (Browser + Build)
tools/build-data.js           erzeugt die vorgenerierten Kacheln unter data/
data/                         vorgenerierte Kacheln (von der Action gebaut)
vendor/                       Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 (BSD-2 / MIT)
.github/workflows/pages.yml   Deploy nach GitHub Pages
.github/workflows/data.yml    wöchentlicher Datenbuild
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
