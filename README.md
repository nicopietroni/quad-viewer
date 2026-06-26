# Mesh Viewer Template

Visualizzatore web statico (Three.js) per confrontare tassellazioni
triangolari e quad di una stessa mesh. Pensato per essere clonato in
una repo GitHub dedicata per ogni cliente/progetto e pubblicato via
GitHub Pages.

## Struttura

```
index.html              pagina principale
css/style.css           stile (dark, tecnico, neutro)
js/viewer.js            logica Three.js: caricamento OBJ, orbit, shading, switch tris/quad
js/sidebar.js           lista mesh, ricerca, selezione
config.json             titolo pagina (personalizzabile per cliente)
meshes/manifest.json    elenco mesh disponibili (generato dallo script)
meshes/*.obj            file mesh (tris)
meshes/*_quad.obj       file mesh (quad, opzionale)
meshes/thumbnails/      anteprime PNG generate
scripts/generate_thumbnails.py   script di generazione thumbnail + manifest
```

## Convenzione file mesh

Per ogni mesh, due file con lo stesso nome base:

```
nome_oggetto.obj         <- versione triangolata (obbligatoria)
nome_oggetto_quad.obj    <- versione quad (opzionale)
```

Se la versione `_quad.obj` non esiste, il viewer mostra solo la
versione tris e il tasto Shift non ha effetto per quella mesh.

## Generare/aggiornare le thumbnail e il manifest

```bash
pip install trimesh pyrender numpy pillow --break-system-packages

python3 scripts/generate_thumbnails.py \
  --input /percorso/alla/cartella/con/gli/obj \
  --output .
```

Lo script:
1. Copia gli `.obj` (tris + quad) dentro `meshes/`
2. Genera una thumbnail PNG per ciascuna mesh in `meshes/thumbnails/`
3. Scrive `meshes/manifest.json`

Usa `--skip-existing` per rigenerare solo le thumbnail mancanti
(utile quando aggiungi poche mesh nuove a una libreria già grande).

## Provare in locale

Serve un server HTTP locale (per i `fetch()` di config/manifest):

```bash
python3 -m http.server 8080
```

poi apri `http://localhost:8080`.

## Pubblicare su GitHub Pages

1. Crea una nuova repo (es. `clientename-mesh-viewer`)
2. Copia dentro tutto il contenuto di questo template
3. Modifica `config.json` con il titolo del cliente
4. Genera mesh + manifest con lo script sopra
5. Push su GitHub
6. Settings → Pages → Deploy from branch → `main` / root

## Workflow multi-cliente

Questo template è la base comune. Per ogni cliente:

1. Clona/copia questo template in una nuova repo
2. Aggiungi le mesh comuni a tutti i clienti + le mesh specifiche
   di quel cliente nella stessa cartella di input prima di lanciare
   `generate_thumbnails.py`
3. Mantieni una cartella locale "mesh comuni" separata da quelle
   "specifiche per cliente X", e uniscile solo al momento della
   generazione (copia entrambe in una cartella temporanea, poi lancia
   lo script su quella)

Per aggiornare le mesh di un cliente in futuro: rigenera con lo stesso
script puntando `--output` alla cartella della repo del cliente, poi
fai commit/push delle modifiche (nuovi file in `meshes/`,
`meshes/thumbnails/`, `meshes/manifest.json`).

## Note tecniche

- Il materiale è impostato `DoubleSide`/`doubleSided=True` sia nel
  viewer Three.js sia nello script di generazione thumbnail: questo
  evita mesh "invisibili" o thumbnail vuote quando le normali delle
  facce non sono orientate in modo coerente.
- Lo shading è flat (`flatShading: true`) con un overlay wireframe
  sottile, per rendere leggibile la tassellazione (tris vs quad)
  piuttosto che l'aspetto "realistico" della superficie.
- Tasto `Shift` per alternare tra versione tris e quad della mesh
  correntemente caricata.
