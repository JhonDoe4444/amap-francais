/* Amap français : prototype de navigation 3D schématique (Île-de-France).
   Une seule page, sans build : MapLibre (fond 3D OpenFreeMap) pour préparer le trajet,
   three.js pour la vue de conduite, OSRM pour l'itinéraire et les voies, Géoplateforme/BAN pour les adresses. */
(function () {
  'use strict';

  // ---------- configuration ----------
  const CFG = {
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    osrmUrl: 'https://router.project-osrm.org/route/v1/driving/',
    valhallaUrl: 'https://valhalla1.openstreetmap.de/trace_attributes',
    geocoders: [
      'https://data.geopf.fr/geocodage/search',
      'https://api-adresse.data.gouv.fr/search/',
    ],
    idfDepts: ['75', '77', '78', '91', '92', '93', '94', '95'],
    center: [2.3488, 48.8534],
  };
  const PRESETS = [
    { label: 'A6 · Porte d’Orléans → Orly', from: { label: 'Porte d’Orléans, Paris', ll: [2.3266, 48.8233] }, to: { label: 'Aéroport d’Orly', ll: [2.3652, 48.7262] } },
    { label: 'A13 · Porte de Saint-Cloud → Versailles', from: { label: 'Porte de Saint-Cloud, Paris', ll: [2.2571, 48.8381] }, to: { label: 'Château de Versailles', ll: [2.1204, 48.8049] } },
    { label: 'A1 · Stade de France → Roissy CDG', from: { label: 'Stade de France, Saint-Denis', ll: [2.3601, 48.9245] }, to: { label: 'Aéroport Roissy-CDG T2', ll: [2.5703, 49.0047] } },
  ];

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const RAD = Math.PI / 180;

  // ---------- géométrie (mètres, x = est, y = nord, cap en degrés depuis le nord) ----------
  function makeProjector(ll0) {
    const kx = Math.cos(ll0[1] * RAD) * 111320, ky = 110540;
    return {
      fwd: (ll) => [(ll[0] - ll0[0]) * kx, (ll[1] - ll0[1]) * ky],
      inv: (p) => [p[0] / kx + ll0[0], p[1] / ky + ll0[1]],
    };
  }
  const bearingOf = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) / RAD + 360) % 360;
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
  function resample(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 0.01) continue;
      const n = Math.ceil(d / step);
      for (let j = 1; j <= n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
    }
    return out;
  }
  function cumul(pts) {
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return s;
  }
  function idxAt(s, d) {
    let lo = 0, hi = s.length - 1;
    if (d <= 0) return 0;
    if (d >= s[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= d) lo = m; else hi = m; }
    return lo;
  }
  function pointAt(R, d) {
    d = clamp(d, 0, R.total);
    const i = idxAt(R.s, d), a = R.pts[i], b = R.pts[i + 1] || a;
    const seg = (R.s[i + 1] - R.s[i]) || 1, t = clamp((d - R.s[i]) / seg, 0, 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
  }
  function headingAt(R, d, span) {
    span = span || 12;
    const p = pointAt(R, Math.max(0, d - span)), q = pointAt(R, Math.min(R.total, d + span));
    return bearingOf([p.x, p.y], [q.x, q.y]);
  }

  // ---------- consignes en français ----------
  const MOD = {
    left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite',
    'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit', uturn: 'demi-tour',
  };
  const sideOf = (mod) => (mod && mod.indexOf('left') >= 0 ? 'left' : mod && mod.indexOf('right') >= 0 ? 'right' : null);
  const DECISION_KINDS = ['turn', 'fork', 'off ramp', 'on ramp', 'end of road', 'roundabout', 'rotary', 'roundabout turn', 'merge'];

  function instruction(m) {
    const dir = m.destinations ? ' direction ' + m.destinations : (m.road ? ' sur ' + m.road : '');
    const sideTxt = m.side === 'left' ? 'à gauche' : m.side === 'right' ? 'à droite' : '';
    switch (m.kind) {
      case 'depart': return 'Partez' + (m.road ? ' sur ' + m.road : '');
      case 'arrive': return 'Arrivée à destination';
      case 'fork': return 'Restez ' + (sideTxt || 'dans l’axe') + dir;
      case 'off ramp': return 'Prenez la sortie' + (m.exits ? ' ' + m.exits : '') + (sideTxt ? ' ' + sideTxt : '') + dir;
      case 'on ramp': return 'Prenez la bretelle' + (sideTxt ? ' ' + sideTxt : '') + dir;
      case 'merge': return 'Insérez-vous' + (m.road ? ' sur ' + m.road : '');
      case 'roundabout': case 'rotary':
        return m.exit ? 'Au rond-point, prenez la ' + m.exit + (m.exit === 1 ? 're' : 'e') + ' sortie' + dir : 'Prenez le rond-point' + dir;
      case 'end of road': return 'Au bout de la route, tournez ' + (MOD[m.modifier] || '') + dir;
      case 'continue': case 'new name':
        return !m.modifier || m.modifier === 'straight' ? 'Continuez' + (m.road ? ' sur ' + m.road : '') : 'Continuez ' + MOD[m.modifier] + dir;
      default:
        if (m.modifier === 'uturn') return 'Faites demi-tour';
        if (m.modifier === 'straight') return 'Continuez tout droit' + dir;
        return 'Tournez ' + (MOD[m.modifier] || '') + dir;
    }
  }
  function fmtDist(m) {
    if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',') + ' km';
    if (m >= 100) return Math.round(m / 50) * 50 + ' m';
    return Math.max(0, Math.round(m / 10) * 10) + ' m';
  }
  function fmtDur(sec) {
    const min = Math.round(sec / 60);
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0');
  }
  const isMotorwaySign = (txt) => /\b(A|N) ?\d/.test(txt || '');

  // ---------- modèle d'itinéraire commun ----------
  // R = { title, source, note, speed, pts, s, total, maneuvers[], junctions[], lonlat?, proj? }
  function finishRoute(R) {
    R.s = cumul(R.pts);
    R.total = R.s[R.s.length - 1];
    const tagBranches = (j) => {
      const h = headingAt(R, j.along + 8, 8);
      j.outBearing = j.outBearing == null ? h : j.outBearing;
      j.branches.forEach((b) => { b.rel = angDiff(b.bearing, headingAt(R, Math.max(0, j.along - 10), 10)); b.side = b.rel >= 0 ? 'right' : 'left'; });
    };
    R.maneuvers.forEach((m) => { m.text = m.text || instruction(m); tagBranches(m); });
    R.junctions.forEach(tagBranches);
    R.maneuvers.sort((a, b) => a.along - b.along);
    R.junctions.sort((a, b) => a.along - b.along);
    return R;
  }

  function fromOsrm(json, from, to) {
    const r = json.routes[0];
    const coords = r.geometry.coordinates;
    const proj = makeProjector(coords[0]);
    const pts = resample(coords.map(proj.fwd), 6);
    const R = { title: from.label + ' → ' + to.label, source: 'osrm', speed: 0, pts, maneuvers: [], junctions: [], proj, lonlat: coords, duration: r.duration, distance: r.distance, laneSegs: [], baseSegs: [], defaultWidth: 10 };
    const s = cumul(pts);
    let cursor = 0;
    const locate = (ll) => {
      const p = proj.fwd(ll);
      let best = cursor, bd = Infinity;
      const end = Math.min(pts.length, cursor + 5000);
      for (let i = cursor; i < end; i++) {
        const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cursor = best;
      return s[best];
    };
    let lanesKnown = 0, decisions = 0;
    r.legs.forEach((leg) => leg.steps.forEach((step) => {
      (step.intersections || []).forEach((it, k) => {
        const along = locate(it.location);
        if (it.lanes && it.lanes.length) R.laneSegs.push([along - 350, along, it.lanes.length]);
        const branches = it.bearings
          .map((b, i) => ({ bearing: b, i }))
          .filter((o) => o.i !== it.in && o.i !== it.out)
          .map((o) => ({ bearing: o.bearing, allowed: it.entry ? it.entry[o.i] : true }));
        if (k === 0) {
          const mv = step.maneuver;
          const m = {
            along, kind: mv.type, modifier: mv.modifier, exit: mv.exit,
            road: step.ref ? (step.name ? step.name + ' (' + step.ref + ')' : step.ref) : step.name,
            destinations: step.destinations || '', exits: step.exits || '',
            lanes: it.lanes && it.lanes.length ? it.lanes.map((l) => ({ ind: l.indications, valid: l.valid })) : null,
            outBearing: it.out != null ? it.bearings[it.out] : null,
            branches,
          };
          m.side = sideOf(m.modifier);
          m.decision = DECISION_KINDS.indexOf(m.kind) >= 0 || ((m.kind === 'continue' || m.kind === 'new name') && m.modifier && m.modifier !== 'straight' && branches.length > 0);
          if (m.decision) { decisions++; if (m.lanes) lanesKnown++; }
          R.maneuvers.push(m);
        } else if (branches.length) {
          R.junctions.push({ along, branches, outBearing: it.out != null ? it.bearings[it.out] : null });
        }
      });
    }));
    R.speed = r.distance / Math.max(1, r.duration);
    R.coverage = { decisions, lanesKnown };
    R.note = 'Itinéraire OSRM sur données OpenStreetMap. Voies tracées seulement quand OSM les renseigne (lanes, turn:lanes).';
    finishRoute(R);
    laneProfile(R);
    return R;
  }

  // Profil de voies : nombre de voies (0 = inconnu) et largeur de chaussée en chaque point du tracé.
  // Sources, de la plus faible à la plus forte : tag OSM lanes (via Valhalla), puis turn:lanes aux carrefours (OSRM).
  const LANE_W = 3.5;
  function laneProfile(R) {
    const n = R.pts.length, lanes = new Array(n).fill(0);
    const apply = (segs) => segs.forEach(([a, b, k]) => {
      for (let i = idxAt(R.s, Math.max(0, a)); i < n && R.s[i] <= b; i++) if (R.s[i] >= a) lanes[i] = k;
    });
    apply(R.baseSegs || []); apply(R.laneSegs || []);
    const raw = lanes.map((k) => (k >= 1 ? Math.max(4.5, k * LANE_W) : R.defaultWidth));
    const width = raw.map((_, i) => {
      let s = 0, c = 0;
      for (let j = i - 6; j <= i + 6; j++) if (j >= 0 && j < n) { s += raw[j]; c++; }
      return s / c;
    });
    let known = 0;
    for (let i = 0; i < n - 1; i++) if (lanes[i] >= 1) known += R.s[i + 1] - R.s[i];
    R.laneArr = lanes; R.widthArr = width;
    R.laneCoverage = R.total ? known / R.total : 0;
  }
  function decodePolyline(str, precision) {
    const f = Math.pow(10, precision || 6), out = [];
    let i = 0, lat = 0, lon = 0;
    const next = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
    while (i < str.length) { lat += next(); lon += next(); out.push([lon / f, lat / f]); }
    return out;
  }
  function makeLocator(R) {
    let cursor = 0;
    return (ll) => {
      const p = R.proj.fwd(ll);
      let best = cursor, bd = Infinity;
      const end = Math.min(R.pts.length, cursor + 5000);
      for (let i = cursor; i < end; i++) {
        const d = (R.pts[i][0] - p[0]) ** 2 + (R.pts[i][1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cursor = best;
      return R.s[best];
    };
  }
  // Nombre de voies par tronçon (tag OSM lanes) via la mise en correspondance Valhalla.
  // Valhalla met 1 voie quand le tag manque : on ne garde que les tronçons à 2 voies ou plus.
  async function fetchLaneCounts(R) {
    const body = JSON.stringify({
      shape: R.lonlat.map((c) => ({ lon: c[0], lat: c[1] })), costing: 'auto', shape_match: 'map_snap',
      filters: { attributes: ['edge.lane_count', 'edge.begin_shape_index', 'edge.end_shape_index', 'shape'], action: 'include' },
    });
    const res = await fetchTimeout(CFG.valhallaUrl, 15000, { method: 'POST', body });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const js = await res.json();
    const shape = decodePolyline(js.shape, 6), locate = makeLocator(R);
    R.baseSegs = (js.edges || []).map((e) => [locate(shape[e.begin_shape_index]), locate(shape[e.end_shape_index]), e.lane_count || 0])
      .filter((s) => s[2] >= 2);
    laneProfile(R);
  }

  // Scénarios : tracé « tortue » (droites et arcs), en mètres.
  function turtle(cmds) {
    let x = 0, y = 0, h = 0;
    const pts = [[0, 0]];
    cmds.forEach((c) => {
      if (c.s) {
        const n = Math.ceil(c.s / 5);
        for (let i = 0; i < n; i++) { x += Math.sin(h * RAD) * c.s / n; y += Math.cos(h * RAD) * c.s / n; pts.push([x, y]); }
      } else if (c.a) {
        const len = Math.abs(c.a) * RAD * c.r, n = Math.max(4, Math.ceil(len / 2));
        for (let i = 0; i < n; i++) {
          const hm = h + c.a * (i + 0.5) / n;
          x += Math.sin(hm * RAD) * len / n; y += Math.cos(hm * RAD) * len / n; pts.push([x, y]);
        }
        h += c.a;
      }
    });
    return pts;
  }
  const L = (ind, valid) => ({ ind: [].concat(ind), valid });
  const SCENARIOS = [
    {
      id: 'fork', title: 'Bifurcation à deux branches', desc: 'Autoroute à 4 voies qui se sépare. Il faut rester sur les deux voies de gauche.',
      icon: ['slight left'], speed: 30, start: 600,
      path: [{ s: 1600 }, { a: -9, r: 900 }, { s: 900 }], lanes: [[0, 1600, 4], [1600, 1e9, 2]],
      maneuvers: [
        { at: 1600, kind: 'fork', modifier: 'slight left', road: 'A6', destinations: 'Lyon · Évry (A6)',
          lanes: [L('slight left', true), L('slight left', true), L('slight right', false), L('slight right', false)],
          branches: [{ rel: 13, label: 'Bordeaux · Nantes (A10)', lanes: 2 }] },
      ],
      junctions: [],
    },
    {
      id: 'exits', title: 'Sorties rapprochées', desc: 'Deux sorties à droite à 450 m d’écart. La bonne est la seconde.',
      icon: ['slight right'], speed: 28, start: 300,
      path: [{ s: 1450 }, { a: 32, r: 260 }, { s: 500 }], lanes: [[0, 1450, 3], [1450, 1e9, 1]],
      maneuvers: [
        { at: 1450, kind: 'off ramp', modifier: 'slight right', exits: '8', destinations: 'Orly · Aéroport',
          lanes: [L('none', false), L('none', false), L('slight right', true)], branches: [{ rel: 0, label: 'Paris · Porte d’Italie', lanes: 2 }] },
      ],
      junctions: [{ at: 1000, branches: [{ rel: 26, label: 'Sortie 7 · Rungis', lanes: 1 }] }],
    },
    {
      id: 'lanes', title: 'Carrefour à cinq voies', desc: 'Boulevard urbain, tourne-à-gauche sur deux voies dédiées.',
      icon: ['left'], speed: 13, start: 80,
      path: [{ s: 520 }, { a: -90, r: 32 }, { s: 380 }], lanes: [[0, 520, 5], [520, 1e9, 2]],
      maneuvers: [
        { at: 520, kind: 'turn', modifier: 'left', road: 'Avenue de la Gare', destinations: 'Gare · Centre-ville',
          lanes: [L('left', true), L('left', true), L('straight', false), L('straight', false), L('right', false)],
          branches: [{ rel: 0 }, { rel: 90 }] },
      ],
      junctions: [{ at: 240, branches: [{ rel: -90 }, { rel: 90 }] }],
    },
    {
      id: 'unknown', title: 'Voies non renseignées', desc: 'Même manœuvre sans données de voies : la scène reste générale, rien n’est inventé.',
      icon: ['right'], speed: 12, start: 60,
      path: [{ s: 430 }, { a: 90, r: 22 }, { s: 320 }],
      maneuvers: [
        { at: 430, kind: 'turn', modifier: 'right', road: 'Rue des Lilas', lanes: null, branches: [{ rel: -90 }, { rel: 0 }] },
      ],
      junctions: [{ at: 200, branches: [{ rel: 90 }] }],
    },
  ];
  function fromScenario(sc) {
    const pts = turtle(sc.path);
    const R = { title: sc.title, source: 'exemple', speed: sc.speed, pts, maneuvers: [], junctions: [], scenario: sc, laneSegs: sc.lanes || [], baseSegs: [], defaultWidth: sc.speed > 20 ? 11 : 9 };
    R.s = cumul(pts); R.total = R.s[R.s.length - 1];
    const mk = (b, along) => ({ bearing: (headingAt(R, Math.max(0, along - 10), 10) + b.rel + 360) % 360, label: b.label || null, lanes: b.lanes || 0 });
    R.maneuvers.push({ along: 0, kind: 'depart', road: '', branches: [] });
    sc.maneuvers.forEach((m) => {
      const o = Object.assign({}, m, { along: m.at, decision: true, side: sideOf(m.modifier), branches: m.branches.map((b) => mk(b, m.at)) });
      R.maneuvers.push(o);
    });
    R.maneuvers.push({ along: R.total, kind: 'arrive', branches: [] });
    sc.junctions.forEach((j) => R.junctions.push({ along: j.at, branches: j.branches.map((b) => mk(b, j.at)) }));
    R.note = 'Scénario d’exemple : géométrie, voies et panneaux saisis à la main pour tester la lisibilité.';
    const dec = R.maneuvers.filter((m) => m.decision);
    R.coverage = { decisions: dec.length, lanesKnown: dec.filter((m) => m.lanes).length };
    finishRoute(R);
    laneProfile(R);
    return R;
  }

  // ---------- pictogrammes (canvas) ----------
  const ANG = { straight: 0, none: 0, 'slight right': 38, 'slight left': -38, right: 82, left: -82, 'sharp right': 130, 'sharp left': -130, 'merge to left': -22, 'merge to right': 22 };
  function drawArrow(ctx, inds, cx, cy, s, color, lw) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.5); ctx.lineTo(cx, cy); ctx.stroke();
    inds.forEach((ind) => {
      if (ind === 'uturn') {
        const r = s * 0.17;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - s * 0.2); ctx.arc(cx - r, cy - s * 0.2, r, 0, Math.PI, true); ctx.lineTo(cx - 2 * r, cy + s * 0.05); ctx.stroke();
        head(ctx, cx - 2 * r, cy + s * 0.05, 180, s);
        return;
      }
      const a = ANG[ind] == null ? 0 : ANG[ind];
      const ex = cx + Math.sin(a * RAD) * s * 0.42, ey = cy - Math.cos(a * RAD) * s * 0.42;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx, cy - s * 0.22, ex, ey); ctx.stroke();
      const dir = bearingOf([cx, -(cy - s * 0.22)], [ex, -ey]);
      head(ctx, ex, ey, Math.abs(a) < 1 ? 0 : dir, s);
    });
    ctx.restore();
  }
  function head(ctx, x, y, bearing, s) {
    const k = s * 0.13, dx = Math.sin(bearing * RAD), dy = -Math.cos(bearing * RAD);
    ctx.beginPath();
    ctx.moveTo(x + dx * k * 1.3, y + dy * k * 1.3);
    ctx.lineTo(x - dy * k, y + dx * k);
    ctx.lineTo(x + dy * k, y - dx * k);
    ctx.closePath(); ctx.fill();
  }
  function maneuverInds(m) {
    if (!m) return ['straight'];
    if (m.kind === 'fork' || m.kind === 'off ramp' || m.kind === 'on ramp') return [m.side === 'left' ? 'slight left' : m.side === 'right' ? 'slight right' : 'straight'];
    return [m.modifier && ANG[m.modifier] != null ? m.modifier : m.modifier === 'uturn' ? 'uturn' : 'straight'];
  }
  function paintIcon(canvas, m) {
    const ctx = canvas.getContext('2d'), w = canvas.width;
    ctx.clearRect(0, 0, w, w);
    if (m && m.kind === 'arrive') {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w / 2, w * 0.42, w * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(w * 0.33, w * 0.5); ctx.lineTo(w / 2, w * 0.82); ctx.lineTo(w * 0.67, w * 0.5); ctx.fill();
      ctx.fillStyle = '#1d4fa8'; ctx.beginPath(); ctx.arc(w / 2, w * 0.42, w * 0.08, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (m && (m.kind === 'roundabout' || m.kind === 'rotary')) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = w * 0.06;
      ctx.beginPath(); ctx.arc(w / 2, w * 0.45, w * 0.17, 0, Math.PI * 2); ctx.stroke();
    }
    drawArrow(ctx, maneuverInds(m), w / 2, w * 0.55, w * 0.62, '#fff', w * 0.085);
  }

  // ---------- scène three.js ----------
  const COL = {
    bg: new THREE.Color('#0a1120'), ground: '#0d1628', grid: '#16223a', asphalt: new THREE.Color('#29344a'), asphaltHi: new THREE.Color('#3a4865'),
    edge: new THREE.Color('#8d9ab4'), guide: new THREE.Color('#3d9bff'), decide: new THREE.Color('#46e0ae'), past: new THREE.Color('#1e293d'),
  };
  const FOG = { near: 260, far: 1500 };
  const GL = {};

  const VERT = `
    attribute float along; attribute float side; attribute float laneN; attribute float roadW;
    varying float vA; varying float vS; varying float vD; varying float vN; varying float vW;
    void main() {
      vA = along; vS = side; vN = laneN; vW = roadW;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vD = length(mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`;
  const FOG_GLSL = `
    uniform vec3 uBg; uniform float uFogNear; uniform float uFogFar;
    vec4 fogged(vec3 c, float a, float d) { float f = smoothstep(uFogNear, uFogFar, d); return vec4(mix(c, uBg, f), a * (1.0 - f * 0.85)); }`;
  const fogUniforms = () => ({ uBg: { value: COL.bg }, uFogNear: { value: FOG.near }, uFogFar: { value: FOG.far } });

  function roadMaterial(color, fadeLen) {
    return new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: Object.assign(fogUniforms(), { uCol: { value: color.clone() }, uEdge: { value: COL.edge }, uLen: { value: fadeLen || 0 }, uDim: { value: 0 } }),
      vertexShader: VERT,
      fragmentShader: FOG_GLSL + `
        uniform vec3 uCol; uniform vec3 uEdge; uniform float uLen; uniform float uDim;
        varying float vA; varying float vS; varying float vD; varying float vN; varying float vW;
        void main() {
          // ligne de rive pleine à 0,3 m du bord
          float edgeU = 0.45 / max(vW, 4.0);
          float u = (vS + 1.0) * 0.5;
          float du = min(u, 1.0 - u);
          float e = smoothstep(edgeU - 0.01, edgeU, du) * (1.0 - smoothstep(edgeU + 0.025, edgeU + 0.035, du)) * step(1.0, vW);
          if (vW < 1.0) e = smoothstep(0.86, 0.9, abs(vS)) * (1.0 - smoothstep(0.95, 0.99, abs(vS)));
          vec3 c = mix(uCol, uEdge, e * 0.75);
          // séparateurs de voies en tirets (seulement si le nombre de voies est connu)
          if (vN > 1.5) {
            float n = floor(vN + 0.5);
            float f = u * n;
            float k = floor(f + 0.5);
            float d = abs(f - k) * vW / n;
            float line = (1.0 - smoothstep(0.07, 0.11, d)) * step(0.5, k) * step(k, n - 0.5);
            float dash = step(fract(vA / 13.0), 0.46);
            c = mix(c, vec3(0.92, 0.95, 1.0), line * dash * 0.8);
          }
          c = mix(c, c * 0.45, uDim);
          float a = 1.0 - smoothstep(0.985, 1.0, abs(vS));
          if (uLen > 0.0) a *= 1.0 - smoothstep(uLen * 0.4, uLen, vA);
          gl_FragColor = fogged(c, a, vD);
        }`,
    });
  }
  function guideMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: Object.assign(fogUniforms(), {
        uPos: { value: 0 }, uNext: { value: -1e9 }, uDecision: { value: 0 }, uTime: { value: 0 },
        uGuide: { value: COL.guide }, uDecide: { value: COL.decide },
        uBandFrom: { value: -1e9 }, uBandTo: { value: -1e9 }, uLo: { value: 0.35 }, uHi: { value: 0.65 },
      }),
      vertexShader: VERT,
      fragmentShader: FOG_GLSL + `
        uniform float uPos; uniform float uNext; uniform float uDecision; uniform float uTime;
        uniform vec3 uGuide; uniform vec3 uDecide;
        uniform float uBandFrom; uniform float uBandTo; uniform float uLo; uniform float uHi;
        varying float vA; varying float vS; varying float vD; varying float vN; varying float vW;
        void main() {
          if (vA < uPos - 1.0) discard;
          // bande guidée : au centre par défaut, glisse sur les voies à prendre avant la manœuvre
          float u = (vS + 1.0) * 0.5;
          float hw = min(0.31, 2.7 / max(vW, 4.0));
          float wl = smoothstep(uBandFrom - 140.0, uBandFrom, vA) * (1.0 - smoothstep(uBandTo + 10.0, uBandTo + 60.0, vA));
          float lo = mix(0.5 - hw, uLo, wl), hi2 = mix(0.5 + hw, uHi, wl);
          float band = smoothstep(lo - 0.015, lo + 0.005, u) * (1.0 - smoothstep(hi2 - 0.005, hi2 + 0.015, u));
          if (band < 0.01) discard;
          float hi = uDecision * smoothstep(uNext - 260.0, uNext - 200.0, vA) * (1.0 - smoothstep(uNext + 200.0, uNext + 260.0, vA));
          vec3 c = mix(uGuide, uDecide, hi);
          float chev = fract((vA + abs(vS) * 5.0) / 16.0 - uTime * (0.9 + hi * 0.8));
          float m = smoothstep(0.62, 0.68, chev) * (1.0 - smoothstep(0.82, 0.88, chev));
          c = mix(c, vec3(1.0), m * (0.35 + 0.4 * hi));
          float a = band * (0.78 + 0.2 * hi);
          a *= smoothstep(uPos - 1.0, uPos + 6.0, vA);
          gl_FragColor = fogged(c, a, vD);
        }`,
    });
  }

  function ribbon(pts, width, y, out, along0, lanes) {
    const n = pts.length, base = out.pos.length / 3;
    let acc = along0 || 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const W = typeof width === 'number' ? width : width[i];
      const nx = -dy, ny = dx, w = W / 2;
      if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      out.pos.push(p[0] + nx * w, y, -(p[1] + ny * w), p[0] - nx * w, y, -(p[1] - ny * w));
      out.along.push(acc, acc); out.side.push(-1, 1);
      const N = lanes ? lanes[i] : 0;
      out.lanes.push(N, N); out.width.push(W, W);
      if (i < n - 1) { const k = base + i * 2; out.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    return out;
  }
  const newBuf = () => ({ pos: [], along: [], side: [], idx: [], lanes: [], width: [] });
  function bufGeometry(buf) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('along', new THREE.Float32BufferAttribute(buf.along, 1));
    g.setAttribute('side', new THREE.Float32BufferAttribute(buf.side, 1));
    g.setAttribute('laneN', new THREE.Float32BufferAttribute(buf.lanes, 1));
    g.setAttribute('roadW', new THREE.Float32BufferAttribute(buf.width, 1));
    g.setIndex(buf.idx);
    return g;
  }
  function stubPts(R, along, bearing, outBearing, len) {
    const o = pointAt(R, along), pts = [[o.x, o.y]];
    const diff = angDiff(bearing, outBearing == null ? headingAt(R, along + 10, 10) : outBearing);
    const sign = Math.sign(diff) || 1, fork = Math.abs(diff) < 40;
    let x = o.x, y = o.y;
    const n = Math.ceil(len / 4);
    for (let i = 1; i <= n; i++) {
      const t = i / n, h = bearing + (fork ? sign * 22 * t * t : 0);
      x += Math.sin(h * RAD) * len / n; y += Math.cos(h * RAD) * len / n; pts.push([x, y]);
    }
    return pts;
  }

  function initScene() {
    const canvas = $('#three');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(COL.bg);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(COL.bg, FOG.near, FOG.far);
    const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6); sun.position.set(200, 400, 100); scene.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: COL.ground }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.3; scene.add(ground);
    const grid = new THREE.GridHelper(1, 1, COL.grid, COL.grid); scene.add(grid);

    // véhicule : flèche de navigation en relief
    const shape = new THREE.Shape();
    shape.moveTo(0, 3.2); shape.lineTo(2.3, -2.4); shape.lineTo(0, -1.2); shape.lineTo(-2.3, -2.4); shape.closePath();
    const carGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.9, bevelEnabled: true, bevelSize: 0.25, bevelThickness: 0.25, bevelSegments: 2 });
    carGeo.rotateX(-Math.PI / 2);
    const car = new THREE.Group();
    const arrow = new THREE.Mesh(carGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x3d9bff, emissiveIntensity: 0.35 }));
    arrow.position.y = 0.4; arrow.scale.setScalar(1.15);
    const halo = new THREE.Mesh(new THREE.CircleGeometry(6, 40), new THREE.MeshBasicMaterial({ color: COL.guide, transparent: true, opacity: 0.22, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.12;
    car.add(halo, arrow); scene.add(car);

    Object.assign(GL, { renderer, scene, camera, ground, grid, car, routeGroup: null, focus: null, camPos: new THREE.Vector3(), camLook: new THREE.Vector3() });
    window.addEventListener('resize', resizeScene);
    resizeScene();
  }
  function resizeScene() {
    const st = $('#stage'), w = st.clientWidth, h = st.clientHeight;
    if (!GL.renderer || !w || !h) return;
    GL.renderer.setSize(w, h, false);
    GL.camera.aspect = w / h; GL.camera.updateProjectionMatrix();
  }
  function disposeGroup(g) {
    if (!g) return;
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    g.parent && g.parent.remove(g);
  }

  function loadScene(R) {
    disposeGroup(GL.routeGroup); disposeGroup(GL.focus); GL.focus = null; GL.focusFor = null;
    const g = new THREE.Group();
    laneProfile(R);
    R.width = R.defaultWidth;
    // route complète : largeur et séparateurs de voies suivant le profil
    g.add(new THREE.Mesh(bufGeometry(ribbon(R.pts, R.widthArr, 0.04, newBuf(), 0, R.laneArr)), roadMaterial(COL.asphalt)));
    const guide = new THREE.Mesh(bufGeometry(ribbon(R.pts, R.widthArr, 0.12, newBuf(), 0, R.laneArr)), guideMaterial());
    guide.renderOrder = 2; g.add(guide);
    // petites rues croisées (fusionnées en une géométrie)
    const minor = newBuf();
    R.junctions.forEach((j) => j.branches.forEach((b) => ribbon(stubPts(R, j.along, b.bearing, j.outBearing, b.lanes ? 160 : 70), b.lanes ? Math.max(4.5, b.lanes * LANE_W) : Math.min(R.width, 8), 0.0, minor, 0)));
    if (minor.pos.length) g.add(new THREE.Mesh(bufGeometry(minor), roadMaterial(COL.asphalt, 70)));
    // branches non prises aux manœuvres : une géométrie par manœuvre pour pouvoir les assombrir
    R.maneuvers.forEach((m) => {
      if (!m.branches.length) return;
      const buf = newBuf();
      m.branches.forEach((b) => {
        const pts = stubPts(R, m.along, b.bearing, m.outBearing, m.decision ? 220 : 80);
        const w = b.lanes ? Math.max(4.5, b.lanes * LANE_W) : R.width * (m.decision ? 0.85 : 0.65);
        ribbon(pts, w, 0.02, buf, 0, b.lanes >= 2 ? pts.map(() => b.lanes) : null);
      });
      m.stubMat = roadMaterial(COL.asphaltHi, m.decision ? 220 : 80);
      g.add(new THREE.Mesh(bufGeometry(buf), m.stubMat));
    });
    GL.scene.add(g);
    GL.routeGroup = g; GL.guideMat = guide.material;
    // sol et grille centrés sur le trajet
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    R.pts.forEach((p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    const size = Math.max(maxX - minX, maxY - minY) + 4000, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    GL.ground.scale.set(size, size, 1); GL.ground.position.set(cx, -0.3, -cy);
    GL.scene.remove(GL.grid);
    const div = Math.min(400, Math.round(size / 100));
    GL.grid = new THREE.GridHelper(div * 100, div, COL.grid, COL.grid);
    GL.grid.position.set(cx, -0.2, -cy);
    GL.scene.add(GL.grid);
    GL.camInit = false;
  }

  function textSprite(lines, bg, scaleH) {
    const pad = 22, fs = 46, lh = 58;
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = '700 ' + fs + 'px "Atkinson Hyperlegible", sans-serif';
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2 + 60;
    const h = lines.length * lh + pad * 2;
    c.width = w; c.height = h;
    ctx.fillStyle = bg; roundRect(ctx, 0, 0, w, h, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5; roundRect(ctx, 7, 7, w - 14, h - 14, 13); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '700 ' + fs + 'px "Atkinson Hyperlegible", sans-serif'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, pad + 30, pad + lh * i + lh / 2));
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(scaleH * w / h, scaleH, 1); sp.renderOrder = 10;
    return sp;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function laneDecal(R, m) {
    const n = m.lanes.length, lw = LANE_W, W = n * lw;
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    c.width = n * 128; c.height = 256;
    m.lanes.forEach((l, i) => drawArrow(ctx, l.ind, i * 128 + 64, 150, 200, l.valid ? '#ffffff' : 'rgba(150,165,190,.45)', 16));
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 1; i < n; i++) for (let y = 0; y < 256; y += 64) ctx.fillRect(i * 128 - 3, y, 6, 36);
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, 16), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.rotation.order = 'YXZ';
    const at = Math.max(0, m.along - 45), p = pointAt(R, at);
    mesh.rotation.x = -Math.PI / 2; mesh.rotation.y = -headingAt(R, at, 20) * RAD;
    mesh.position.set(p.x, 0.2, -p.y); mesh.renderOrder = 3;
    return mesh;
  }
  // panneaux et marquages de la prochaine manœuvre, créés à la demande
  function buildFocus(R, m) {
    disposeGroup(GL.focus);
    const g = new THREE.Group();
    const chosen = m.destinations || m.road;
    if (chosen && m.decision) {
      const arrowTxt = m.side === 'left' ? '← ' : m.side === 'right' ? '→ ' : '↑ ';
      const big = R.speed > 20;
      const sp = textSprite([arrowTxt + chosen], isMotorwaySign(chosen + ' ' + (m.road || '')) ? '#1d4fa8' : '#0f7a47', big ? 20 : 8);
      const p = pointAt(R, Math.min(R.total, m.along + 70));
      sp.position.set(p.x, big ? 26 : 13, -p.y); g.add(sp);
    }
    m.branches.forEach((b) => {
      if (!b.label) return;
      const pts = stubPts(R, m.along, b.bearing, m.outBearing, 90), q = pts[pts.length - 1];
      const sp = textSprite([b.label], 'rgba(40,52,76,.95)', R.speed > 20 ? 14 : 6);
      sp.position.set(q[0], 11, -q[1]); g.add(sp);
    });
    if (m.lanes && m.decision) g.add(laneDecal(R, m));
    GL.scene.add(g);
    GL.focus = g; GL.focusFor = m;
  }

  // ---------- état de la simulation ----------
  const SIM = { R: null, pos: 0, playing: false, mult: 2, view: '3d', decision: 0, time: 0, last: 0, hudAt: 0 };

  function nextManeuver(R, pos) {
    for (const m of R.maneuvers) if (m.along > pos + 1 && m.kind !== 'depart') return m;
    return R.maneuvers[R.maneuvers.length - 1];
  }
  const decisionRange = (R) => clamp(R.speed * 14, 160, 480);

  function frame(t) {
    requestAnimationFrame(frame);
    if (!SIM.R || $('#app').dataset.mode !== 'nav') { SIM.last = t; return; }
    const dt = Math.min(0.1, (t - (SIM.last || t)) / 1000);
    SIM.last = t; SIM.time += dt;
    const R = SIM.R;
    if (SIM.playing) {
      SIM.pos += R.speed * SIM.mult * dt;
      if (SIM.pos >= R.total) { SIM.pos = R.total; setPlaying(false); }
    }
    const m = nextManeuver(R, SIM.pos);
    const toNext = m.along - SIM.pos;
    const range = decisionRange(R);
    const target = m.decision && toNext < range ? 1 : 0;
    SIM.decision = lerp(SIM.decision, target, 1 - Math.exp(-dt * 4));
    if (GL.focusFor !== m) buildFocus(R, m);
    if (GL.focus) GL.focus.visible = toNext < Math.max(900, range * 2);
    R.maneuvers.forEach((mm) => { if (mm.stubMat) mm.stubMat.uniforms.uDim.value = mm === m ? SIM.decision : 0; });
    const u = GL.guideMat.uniforms;
    u.uPos.value = SIM.pos; u.uNext.value = m.decision ? m.along : -1e9; u.uDecision.value = SIM.decision; u.uTime.value = SIM.time;
    const band = m.decision && m.lanes ? validRange(m.lanes) : null;
    if (band) {
      const n = m.lanes.length, inset = 0.12 / n;
      u.uLo.value = band[0] / n + inset; u.uHi.value = (band[1] + 1) / n - inset;
      u.uBandTo.value = m.along; u.uBandFrom.value = m.along - Math.max(320, range * 1.4);
    } else { u.uBandFrom.value = -1e9; u.uBandTo.value = -1e9; }

    // véhicule
    const p = pointAt(R, SIM.pos), hd = headingAt(R, SIM.pos, 10);
    GL.car.position.set(p.x, 0, -p.y);
    GL.car.rotation.y = -hd * RAD;
    updateCamera(R, p, toNext, dt);
    GL.renderer.render(GL.scene, GL.camera);

    if (t - SIM.hudAt > 90) { SIM.hudAt = t; updateHud(R, m, toNext, range); updateMinimap(R, p, hd); }
  }

  function validRange(lanes) {
    let a = -1, b = -1;
    lanes.forEach((l, i) => { if (l.valid) { if (a < 0) a = i; b = i; } });
    return a < 0 ? null : [a, b];
  }

  function updateCamera(R, p, toNext, dt) {
    const cam = GL.camera, d = SIM.decision;
    let pos, look;
    if (SIM.view === '2d') {
      pos = new THREE.Vector3(p.x, 420, -p.y + 0.01);
      look = new THREE.Vector3(p.x, 0, -p.y);
      cam.up.set(0, 0, -1);
    } else {
      cam.up.set(0, 1, 0);
      const camHd = headingAt(R, SIM.pos + 10, 30);
      const dx = Math.sin(camHd * RAD), dz = -Math.cos(camHd * RAD);
      const back = lerp(62, 38, d), height = lerp(34, 22, d);
      pos = new THREE.Vector3(p.x - dx * back, height, -p.y - dz * back);
      const aheadD = lerp(45, clamp(toNext + 40, 40, 160), d);
      const a = pointAt(R, Math.min(R.total, SIM.pos + aheadD));
      look = new THREE.Vector3(a.x, 0, -a.y);
    }
    if (!GL.camInit) { GL.camPos.copy(pos); GL.camLook.copy(look); GL.camInit = true; }
    const k = 1 - Math.exp(-dt * 3.2);
    GL.camPos.lerp(pos, k); GL.camLook.lerp(look, k);
    cam.position.copy(GL.camPos); cam.lookAt(GL.camLook);
  }

  function updateHud(R, m, toNext, range) {
    const ban = $('#banner'), decide = SIM.decision > 0.5;
    $('#manDist').textContent = m.kind === 'arrive' && toNext < 5 ? 'Arrivé' : fmtDist(toNext);
    $('#manText').textContent = m.text;
    $('#manRoad').textContent = m.kind === 'off ramp' || m.kind === 'fork' ? (m.road || '') : (m.destinations && m.road ? m.road : '');
    ban.classList.toggle('decide', decide);
    ban.classList.toggle('green', !isMotorwaySign((m.destinations || '') + ' ' + (m.road || '')));
    $('#decisionChip').hidden = !decide;
    const key = m.along + '|' + (m.decision && toNext < range * 2.2);
    if (ban.dataset.key !== key) { ban.dataset.key = key; paintIcon($('#manIcon'), m); renderLanes(m, m.decision && toNext < range * 2.2); }
    // sorties intermédiaires du même côté
    const hint = $('#hint');
    let msg = '';
    if (m.decision && m.side && toNext < range * 2.5) {
      const before = R.junctions.filter((j) => j.along > SIM.pos + 5 && j.along < m.along - 5 && j.branches.some((b) => b.side === m.side && Math.abs(b.rel) < 110));
      if (before.length && before.length <= 3) {
        const what = m.kind === 'off ramp' || m.kind === 'fork' ? 'sortie' : 'rue';
        const sideTxt = m.side === 'left' ? 'à gauche' : 'à droite';
        msg = before.length === 1
          ? 'Ignorez la première ' + what + ' ' + sideTxt + ' (dans ' + fmtDist(before[0].along - SIM.pos) + '). La vôtre est la suivante.'
          : 'Ignorez les ' + before.length + ' ' + what + 's ' + sideTxt + '. La vôtre est la ' + (before.length + 1) + 'e.';
      }
    }
    hint.textContent = msg; hint.hidden = !msg;
    const kmh = SIM.playing ? Math.round(R.speed * 3.6) : 0;
    const remain = R.total - SIM.pos;
    const k = R.laneArr[idxAt(R.s, SIM.pos)];
    $('#stats').innerHTML = '<b>' + kmh + '</b> km/h simulés · ' + (k >= 1 ? '<b>' + k + '</b> voie' + (k > 1 ? 's' : '') : 'voies inconnues') +
      ' · reste <b>' + fmtDist(remain) + '</b> · ' + fmtDur(remain / R.speed);
    const sc = $('#scrub'); if (document.activeElement !== sc) sc.value = Math.round(SIM.pos / R.total * 1000);
  }
  function renderLanes(m, show) {
    const box = $('#lanes');
    box.innerHTML = '';
    if (!show) { box.hidden = true; return; }
    box.hidden = false;
    if (!m.lanes) {
      box.innerHTML = '<div class="lane-note"><strong>Voies non renseignées</strong> dans OpenStreetMap pour cette manœuvre. Suivez la direction indiquée.</div>';
      return;
    }
    m.lanes.forEach((l) => {
      const c = document.createElement('canvas'); c.width = 92; c.height = 116;
      c.className = l.valid ? 'ok' : '';
      drawArrow(c.getContext('2d'), l.ind, 46, 64, 84, l.valid ? '#ffffff' : 'rgba(150,165,190,.55)', 9);
      c.title = (l.valid ? 'Voie à prendre : ' : 'Voie à éviter : ') + l.ind.join(', ');
      box.appendChild(c);
    });
  }

  function setPlaying(on) {
    SIM.playing = on;
    $('#playBtn').textContent = on ? '❚❚' : '▶';
    $('#playBtn').setAttribute('aria-label', on ? 'Pause' : 'Lecture');
  }
  function startNav(R, startPos) {
    SIM.R = R; SIM.pos = startPos || 0; SIM.decision = 0;
    $('#app').dataset.mode = 'nav';
    $('#app').classList.toggle('no-minimap', !(R.source === 'osrm' && MAP.ok));
    $('#app').classList.remove('panel-open');
    $('#srcNote').textContent = R.note;
    resizeScene();
    loadScene(R);
    if (MAP.ok) setTimeout(() => MAP.map.resize(), 50);
    $('#banner').dataset.key = '';
    setPlaying(true);
  }
  function exitNav() {
    setPlaying(false);
    $('#app').dataset.mode = 'plan';
    if (MAP.ok) setTimeout(() => { MAP.map.resize(); MAP.map.easeTo({ pitch: 45, bearing: -10, duration: 600 }); if (MAP.car) MAP.car.remove(); MAP.car = null; fitRoute(); }, 50);
  }

  // ---------- carte MapLibre ----------
  const MAP = { ok: false, map: null, from: null, to: null, markers: {}, car: null, route: null };
  async function initMap() {
    try {
      if (!window.maplibregl) throw new Error('maplibre');
      const res = await fetchTimeout(CFG.styleUrl, 6000);
      if (!res.ok) throw new Error('style');
      const style = await res.json();
      MAP.map = new maplibregl.Map({ container: 'map', style, center: CFG.center, zoom: 13.2, pitch: 55, bearing: -17, maxPitch: 75, attributionControl: { compact: true } });
      MAP.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      MAP.ok = true;
      MAP.map.on('load', () => {
        MAP.map.addSource('route', { type: 'geojson', data: emptyFC() });
        MAP.map.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#0a1120', 'line-width': 10, 'line-opacity': 0.8 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
        MAP.map.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': '#3d9bff', 'line-width': 6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
        MAP.map.addSource('maneuvers', { type: 'geojson', data: emptyFC() });
        MAP.map.addLayer({ id: 'maneuvers', type: 'circle', source: 'maneuvers', paint: {
          'circle-radius': 6, 'circle-stroke-width': 2, 'circle-stroke-color': '#0a1120',
          'circle-color': ['case', ['get', 'lanes'], '#46e0ae', '#93a3bf'] } });
      });
    } catch (e) {
      MAP.ok = false;
      $('#map').hidden = true;
      $('#mapFallback').hidden = false;
    }
  }
  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
  function setMarker(kind, ll) {
    if (!MAP.ok) return;
    if (MAP.markers[kind]) MAP.markers[kind].remove();
    const el = document.createElement('div'); el.className = 'mk mk-' + kind;
    MAP.markers[kind] = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(MAP.map);
    if (!MAP.route) MAP.map.flyTo({ center: ll, zoom: 14 });
  }
  function showRouteOnMap(R) {
    if (!MAP.ok || !MAP.map.getSource('route')) return;
    MAP.map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: R.lonlat }, properties: {} });
    MAP.map.getSource('maneuvers').setData({ type: 'FeatureCollection', features: R.maneuvers.filter((m) => m.decision).map((m) => {
      const p = pointAt(R, m.along);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: R.proj.inv([p.x, p.y]) }, properties: { lanes: !!m.lanes } };
    }) });
    fitRoute();
  }
  function fitRoute() {
    if (!MAP.ok || !MAP.route) return;
    const b = new maplibregl.LngLatBounds();
    MAP.route.lonlat.forEach((c) => b.extend(c));
    MAP.map.fitBounds(b, { padding: 70, pitch: 45, duration: 800 });
  }
  function updateMinimap(R, p, hd) {
    if (!MAP.ok || R.source !== 'osrm') return;
    const ll = R.proj.inv([p.x, p.y]);
    if (!MAP.car) {
      const el = document.createElement('div'); el.className = 'mk mk-car';
      MAP.car = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(ll).addTo(MAP.map);
    }
    MAP.car.setLngLat(ll).setRotation(hd);
    MAP.map.jumpTo({ center: ll, zoom: 16.2, bearing: hd, pitch: 55 });
  }

  // ---------- adresses (Géoplateforme / BAN) ----------
  function fetchTimeout(url, ms, opts) {
    const ctl = new AbortController(), id = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctl.signal }, opts)).finally(() => clearTimeout(id));
  }
  async function geocode(q) {
    let lastErr;
    for (const base of CFG.geocoders) {
      try {
        const url = base + '?q=' + encodeURIComponent(q) + '&limit=10&lat=' + CFG.center[1] + '&lon=' + CFG.center[0];
        const res = await fetchTimeout(url, 5000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const js = await res.json();
        return (js.features || []).filter((f) => {
          const pc = String(f.properties.postcode || f.properties.citycode || '');
          return CFG.idfDepts.indexOf(pc.slice(0, 2)) >= 0;
        }).slice(0, 6).map((f) => ({
          label: f.properties.name || f.properties.label,
          sub: [f.properties.postcode, f.properties.city].filter(Boolean).join(' '),
          full: f.properties.label, ll: f.geometry.coordinates,
        }));
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('géocodage');
  }
  function bindSearch(kind) {
    const input = $('#' + kind + 'Input'), list = $('#' + kind + 'Suggest');
    let timer = null, items = [], sel = -1, seq = 0;
    const close = () => { list.hidden = true; sel = -1; };
    const pick = (it) => {
      input.value = it.full || it.label; close();
      MAP[kind] = { label: it.label, ll: it.ll };
      setMarker(kind, it.ll);
    };
    const render = () => {
      list.innerHTML = '';
      if (!items.length) { list.innerHTML = '<li class="empty">Aucune adresse trouvée en Île-de-France</li>'; list.hidden = false; return; }
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option'); li.setAttribute('aria-selected', i === sel ? 'true' : 'false');
        li.innerHTML = '<span></span><small></small>';
        li.firstChild.textContent = it.label; li.lastChild.textContent = it.sub;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
        list.appendChild(li);
      });
      list.hidden = false;
    };
    input.addEventListener('input', () => {
      MAP[kind] = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try { const r = await geocode(q); if (my !== seq) return; items = r; sel = -1; render(); }
        catch (e) { if (my !== seq) return; items = []; list.innerHTML = '<li class="empty">Le service d’adresses ne répond pas.</li>'; list.hidden = false; }
      }, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { pick(items[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  // ---------- itinéraire (OSRM) ----------
  async function computeRoute() {
    const msg = $('#routeMsg'), btn = $('#routeBtn');
    msg.className = 'msg';
    if (!MAP.from || !MAP.to) { msg.textContent = 'Choisissez un départ et une arrivée dans la liste proposée.'; msg.className = 'msg error'; return; }
    btn.disabled = true; msg.textContent = 'Calcul de l’itinéraire…';
    try {
      const url = CFG.osrmUrl + MAP.from.ll.join(',') + ';' + MAP.to.ll.join(',') + '?overview=full&geometries=geojson&steps=true';
      const res = await fetchTimeout(url, 12000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const js = await res.json();
      if (js.code !== 'Ok' || !js.routes || !js.routes.length) throw new Error(js.message || 'aucun itinéraire');
      const R = fromOsrm(js, MAP.from, MAP.to);
      msg.textContent = 'Lecture du nombre de voies…';
      try { await fetchLaneCounts(R); R.lanesSource = 'valhalla'; }
      catch (e) { R.lanesSource = 'carrefours'; }
      MAP.route = R;
      msg.textContent = R.lanesSource === 'valhalla' ? '' : 'Nombre de voies connu seulement aux carrefours renseignés (service Valhalla indisponible).';
      showRouteOnMap(R);
      renderSummary(R);
    } catch (e) {
      msg.className = 'msg error';
      msg.textContent = 'Le serveur d’itinéraires (démo OSRM) n’a pas répondu. Réessayez, ou lancez un scénario ci-dessous.';
    } finally { btn.disabled = false; }
  }
  function renderSummary(R) {
    const box = $('#routeSummary');
    const c = R.coverage, pct = c.decisions ? Math.round(c.lanesKnown / c.decisions * 100) : 0;
    box.innerHTML = '<div class="big">' + fmtDist(R.distance) + '<small>' + fmtDur(R.duration) + '</small></div>' +
      '<dl><dt>Manœuvres à décision</dt><dd>' + c.decisions + '</dd>' +
      '<dt>Avec voies renseignées (OSM)</dt><dd>' + c.lanesKnown + ' (' + pct + ' %)</dd>' +
      '<dt>Nombre de voies connu</dt><dd>' + Math.round(R.laneCoverage * 100) + ' % du trajet</dd>' +
      '<dt>Intersections traversées</dt><dd>' + R.junctions.length + '</dd></dl>' +
      '<button class="btn btn-go" id="goBtn">Démarrer la navigation simulée</button>';
    box.hidden = false;
    $('#goBtn').addEventListener('click', () => startNav(R, 0));
  }

  // ---------- interface ----------
  function buildPanel() {
    const pre = $('#presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = p.label;
      b.addEventListener('click', () => {
        MAP.from = p.from; MAP.to = p.to;
        $('#fromInput').value = p.from.label; $('#toInput').value = p.to.label;
        setMarker('from', p.from.ll); setMarker('to', p.to.ll);
        computeRoute();
      });
      pre.appendChild(b);
    });
    const list = $('#scenarioList');
    SCENARIOS.forEach((sc) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'scenario'; b.dataset.id = sc.id;
      const ic = document.createElement('canvas'); ic.width = 68; ic.height = 68;
      const ctx = ic.getContext('2d'); ctx.fillStyle = sc.speed > 20 ? '#1d4fa8' : '#0f7a47'; roundRect(ctx, 0, 0, 68, 68, 12); ctx.fill();
      drawArrow(ctx, sc.icon, 34, 38, 42, '#fff', 6);
      const t = document.createElement('div');
      t.innerHTML = '<strong></strong><span></span>'; t.firstChild.textContent = sc.title; t.lastChild.textContent = sc.desc;
      b.append(ic, t);
      b.addEventListener('click', () => runScenario(sc));
      list.appendChild(b);
    });
    $('#routeForm').addEventListener('submit', (e) => { e.preventDefault(); computeRoute(); });
    $('#locateBtn').addEventListener('click', () => {
      const msg = $('#routeMsg');
      if (!navigator.geolocation) { msg.textContent = 'La géolocalisation n’est pas disponible ici.'; return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const ll = [pos.coords.longitude, pos.coords.latitude];
        MAP.from = { label: 'Ma position', ll }; $('#fromInput').value = 'Ma position'; setMarker('from', ll);
      }, () => { msg.className = 'msg error'; msg.textContent = 'Position refusée ou indisponible. Saisissez une adresse de départ.'; }, { timeout: 8000 });
    });
    bindSearch('from'); bindSearch('to');

    $('#playBtn').addEventListener('click', () => { if (SIM.pos >= SIM.R.total) SIM.pos = 0; setPlaying(!SIM.playing); });
    $('#speedSel').addEventListener('change', (e) => { SIM.mult = Number(e.target.value); });
    $('#scrub').addEventListener('input', (e) => { SIM.pos = Number(e.target.value) / 1000 * SIM.R.total; GL.camInit = false; });
    $('#replayBtn').addEventListener('click', () => {
      const R = SIM.R, ahead = R.maneuvers.filter((m) => m.decision && m.along > SIM.pos - 80);
      const prev = R.maneuvers.filter((m) => m.decision && m.along <= SIM.pos - 80).pop();
      const m = (prev && (!ahead.length || SIM.pos - prev.along < 300)) ? prev : ahead[0] || prev;
      if (!m) return;
      SIM.pos = Math.max(0, m.along - decisionRange(R) - 250); GL.camInit = false; setPlaying(true);
    });
    $('#viewBtn').addEventListener('click', () => {
      SIM.view = SIM.view === '3d' ? '2d' : '3d';
      $('#viewBtn').textContent = SIM.view === '3d' ? 'Vue 2D' : 'Vue 3D';
      GL.camInit = false;
    });
    $('#exitBtn').addEventListener('click', exitNav);
    $('#panelToggle').addEventListener('click', () => $('#app').classList.toggle('panel-open'));
    document.addEventListener('keydown', (e) => {
      if ($('#app').dataset.mode !== 'nav' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
    });
  }
  function runScenario(sc) {
    document.querySelectorAll('.scenario').forEach((b) => b.classList.toggle('active', b.dataset.id === sc.id));
    startNav(fromScenario(sc), sc.start);
  }

  // ---------- démarrage ----------
  buildPanel();
  initScene();
  requestAnimationFrame(frame);
  initMap().then(() => {
    // sans fond de carte (hors ligne), on ouvre directement le premier scénario
    if (!MAP.ok) runScenario(SCENARIOS[0]);
  });

  // accès pour les tests
  window.AMAP_FR = { SIM, SCENARIOS, fromScenario, fromOsrm, runScenario, startNav, MAP };
})();
