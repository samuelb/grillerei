# Grillerei

Kleine Karten-Website, die öffentliche **Grillplätze, Feuerstellen, Picknick- und Rastplätze**
sowie **Schutzhütten** anzeigt. Die Daten kommen live aus OpenStreetMap (Overpass API),
die Karte startet auf der aktuellen GPS-Position.

## Starten

Geolocation funktioniert in Browsern nur in einem *secure context*. Über `file://` blockieren
Chrome und Safari die Standortabfrage – deshalb einen lokalen Server nutzen:

```bash
cd /Users/samuel/Workspace/Grillerei
python3 -m http.server 8000
```

Dann <http://localhost:8000> öffnen und die Standortfreigabe bestätigen.

## Veröffentlichen (GitHub Pages)

Die Seite ist rein statisch – **kein Framework, kein Bundler, kein Build-Schritt**. Leaflet
und MarkerCluster liegen unter `vendor/` im Repo, zur Laufzeit wird kein CDN geladen.
Alle Pfade sind relativ, die Seite funktioniert daher auch unter
`https://<user>.github.io/<repo>/`.

```bash
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

Danach in **Settings → Pages → Build and deployment → Source: GitHub Actions** auswählen.
Der Workflow `.github/workflows/pages.yml` lädt das Repo unverändert als Pages-Artefakt
hoch und deployt es bei jedem Push auf `main`.

Alternativ ohne Actions: **Source: Deploy from a branch → `main` / `/ (root)`**. Dafür ist
`.nojekyll` im Repo, damit GitHub die Dateien nicht durch Jekyll schickt.

GitHub Pages liefert per HTTPS aus – die Standortabfrage funktioniert dort also direkt.

## Funktionen

- **Startpunkt = GPS-Position.** Beim Laden wird `navigator.geolocation` abgefragt; bei
  Ablehnung oder Fehler zeigt die Karte Deutschland, und es kann per Ortssuche
  (Nominatim) navigiert werden. Der Button „Mein Standort“ wiederholt die Abfrage.
- **Live-Daten.** Beim Verschieben/Zoomen wird der sichtbare Ausschnitt (mit 25 % Rand)
  bei Overpass abgefragt, entprellt und mit Merker über bereits geladene Bereiche, damit
  nicht doppelt geladen wird. Ab Zoomstufe 11 aufwärts, darunter wäre die Abfrage zu groß.
- **Kategoriefilter** als Chips mit Trefferzahl; die Auswahl wird in `localStorage` gemerkt.
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

## Dateien

```
index.html                    Seitengerüst
style.css                     Layout, Light/Dark, Marker- und Popup-Stile
app.js                        Karte, Geolocation, Overpass-Abfrage, Filter, Liste
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
