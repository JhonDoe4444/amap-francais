# Amap français · prototype web

Prototype de navigation 3D schématique pour l'Île-de-France, conforme au document de cadrage : la priorité est de rendre la bonne branche évidente avant une bifurcation, pas le photoréalisme.

## Lancer en local

Le prototype est un seul fichier HTML, sans installation.

```bash
cd prototype
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Ouvrir directement `index.html` dans le navigateur fonctionne aussi. Une connexion internet est nécessaire pour le fond de carte, les adresses et les itinéraires ; les scénarios de bifurcation fonctionnent hors ligne.

## Ce que fait le prototype

- **Recherche d'adresses** en Île-de-France (Géoplateforme IGN / Base Adresse Nationale), résultats filtrés sur les départements 75, 77, 78, 91, 92, 93, 94, 95.
- **Carte 3D** (MapLibre + OpenFreeMap, bâtiments extrudés OSM) pour préparer le trajet.
- **Itinéraire OSRM** avec étapes, intersections et voies (`turn:lanes` d'OSM quand elles existent).
- **Audit de couverture** du trajet : nombre de manœuvres à décision et part de celles dont les voies sont renseignées dans OSM.
- **Navigation simulée** rejouable (lecture, vitesse ×1 à ×8, curseur, « Rejouer la manœuvre ») dans une scène three.js : route en ruban, flèche du véhicule, caméra qui suit.
- **Voies tracées sur la chaussée** comme dans Amap : largeur de route = nombre de voies × 3,5 m, séparateurs en tirets, nombre de voies affiché en bas. Sources : tag OSM `lanes` par tronçon (lu via la mise en correspondance Valhalla `trace_attributes`), complété par `turn:lanes` aux carrefours (OSRM). Valhalla met 1 voie quand le tag manque, donc seuls les tronçons à 2 voies ou plus sont pris en compte ; ailleurs la route reste générique.
- **Bande de guidage par voie** : avant une manœuvre dont les voies sont connues, la bande verte glisse sur les voies à prendre, et les flèches de voies s'affichent dans le bandeau du haut.
- **Mode décision** à l'approche d'une manœuvre (≈ 14 s avant, entre 160 et 480 m) : caméra plus basse, branche à prendre surlignée en vert avec chevrons animés, branches à éviter assombries, panneau directionnel, flèches de voies au sol et dans le bandeau.
- **Alerte « sortie suivante »** quand une autre sortie ou rue du même côté précède la vôtre.
- **Données absentes** : sans voies dans OSM, le bandeau le dit et la scène reste générale. Rien n'est inventé.
- **Vue 2D** classique (vue du dessus, nord en haut) pour comparer avec la 3D, comme prévu à l'étape 5 du cadrage.
- **4 scénarios de test** hors ligne : bifurcation à deux branches, sorties rapprochées, carrefour à cinq voies, voies non renseignées. Leur géométrie est saisie à la main et ne décrit pas un lieu réel.

## Structure

```
prototype/
  index.html          fichier assemblé, à ouvrir
  build.py            assemble src/ → index.html et dist/artifact.html
  src/body.html       structure de la page
  src/app.css         styles
  src/app.js          logique (géométrie, OSRM, scène 3D, HUD)
  src/maplibre-gl.css feuille de style MapLibre (copie du paquet npm 4.7.1)
  dist/artifact.html  version publiée en démo (sans squelette HTML)
```

Après une modification dans `src/`, relancer `python3 build.py`.

## Composants et licences

| Brique | Service | Licence / conditions |
|---|---|---|
| Données routières | OpenStreetMap | ODbL, attribution « © contributeurs OpenStreetMap » obligatoire |
| Nombre de voies | Serveur Valhalla public FOSSGIS (`valhalla1.openstreetmap.de`) | Usage raisonnable, pas pour la production |
| Itinéraire | Serveur de démo OSRM (`router.project-osrm.org`) | Usage raisonnable seulement, pas pour la production. À remplacer par une instance OSRM ou Valhalla hébergée (extrait Geofabrik Île-de-France) |
| Adresses | Géoplateforme IGN (`data.geopf.fr/geocodage`), repli sur `api-adresse.data.gouv.fr` | Service public gratuit, Licence Ouverte |
| Fond de carte | OpenFreeMap (style Liberty) | Gratuit, sans clé, données OSM |
| Rendu | three.js r128, MapLibre GL JS 4.7.1 | MIT, BSD-3 |

Aucune clé d'API ni compte n'est nécessaire.

## Limites connues

- Le serveur OSRM de démonstration peut être lent ou refuser des requêtes ; c'est la première chose à héberger soi-même.
- OSRM ne transmet pas `destination:lanes` voie par voie : les destinations s'affichent au niveau de la manœuvre.
- Les branches non prises sont dessinées depuis les angles des intersections OSRM (schématique), pas depuis la vraie géométrie des bretelles. L'étape suivante est d'extraire la géométrie OSM autour de chaque échangeur.
- La position est simulée le long de l'itinéraire. Pas encore de GPS temps réel ni de rejeu de traces GPX.
- Pas de voix, pas de trafic, pas de recalcul en cas d'écart.

## Pistes pour la suite

1. Héberger OSRM ou Valhalla sur l'extrait OSM Île-de-France (Valhalla expose mieux les voies et les panneaux).
2. Audit des tags `lanes`, `turn:lanes`, `destination:lanes` sur une zone test (A6/A10, A86, A13/A12) via Overpass.
3. Géométrie réelle des bretelles autour des échangeurs pour la scène 3D.
4. Rejeu de traces GPX enregistrées, puis GPS temps réel.
5. Test utilisateur 3D contre 2D sur les scénarios.
