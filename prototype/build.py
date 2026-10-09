#!/usr/bin/env python3
"""Assemble src/ en un seul fichier HTML autonome : index.html (local) et dist/artifact.html (sans squelette)."""
from pathlib import Path
root = Path(__file__).parent
src = root / "src"
head = """<title>Amap français</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Saira+Condensed:wght@600;700&display=swap">
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
"""
css = (src / "maplibre-gl.css").read_text() + "\n" + (src / "app.css").read_text()
page = head + "<style>\n" + css + "\n</style>\n" + (src / "body.html").read_text() + "<script>\n" + (src / "app.js").read_text() + "\n</script>\n"
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "artifact.html").write_text(page)
top = head + "<style>\n" + css + "\n</style>\n"
rest = (src / "body.html").read_text() + "<script>\n" + (src / "app.js").read_text() + "\n</script>\n"
(root / "index.html").write_text('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + top + "</head>\n<body>\n" + rest + "</body>\n</html>\n")
print("ok", len(page))
