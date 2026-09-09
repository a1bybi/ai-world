// The window onto the world. Terrain is painted once per world into an offscreen
// buffer; everything that changes — resources, weather, paths, people — is drawn
// on top each frame. Overlays let the observer see what is normally invisible:
// mood, hunger, knowledge, danger, footfall.
//
// Structures are drawn as small footprints whose color follows material and
// condition, so a stone store does not look like a reed shelter.

import { TERRAIN, TERRAIN_NAME } from '../world/world.js';
import { clamp } from '../core/util.js';

const BASE = {
  [TERRAIN.DEEP]:   [18, 32, 46],
  [TERRAIN.WATER]:  [30, 56, 74],
  [TERRAIN.MARSH]:  [52, 66, 51],
  [TERRAIN.MEADOW]: [96, 112, 56],
  [TERRAIN.GRASS]:  [74, 88, 48],
  [TERRAIN.FOREST]: [44, 68, 42],
  [TERRAIN.HILL]:   [92, 84, 66],
  [TERRAIN.ROCK]:   [104, 100, 94],
  [TERRAIN.SAND]:   [134, 118, 88],
};

/** Fallback when material is unknown — by structure kind. */
const KIND_COLOR = {
  shelter: '#cbb79a',
  hearth: '#e08a3c',
  store: '#d8c48a',
  workshop: '#c99a63',
  field: '#8bb35a',
  well: '#7eb0c8',
  shrine: '#a08fd0',
  wall: '#9a9590',
  hall: '#d4b896',
  plaza: '#c4b8a0',
  market: '#d8c48a',
  bridge: '#a89070',
  path: '#c4a878',
};

/** Material key (or ontology word fragment) → fill color. */
const MATERIAL_COLOR = {
  wood: '#a67c52',
  timber: '#a67c52',
  reed: '#9aaa5c',
  fibre: '#b8a878',
  fiber: '#b8a878',
  stone: '#9a9690',
  rock: '#9a9690',
  clay: '#c4845a',
  earth: '#8b7355',
  ore: '#8a7a6a',
  metal: '#8a8a96',
  bone: '#d4cbb8',
  hide: '#8b6914',
  thatch: '#b8a060',
};

export const OVERLAYS = [
  { key: 'none',      label: 'plain' },
  { key: 'resources', label: 'resources' },
  { key: 'mood',      label: 'mood' },
  { key: 'hunger',    label: 'hunger' },
  { key: 'knowledge', label: 'knowing' },
  { key: 'trails',    label: 'paths' },
  { key: 'danger',    label: 'danger' },
];

function materialColor(s) {
  const raw = String(s.material || '').toLowerCase();
  if (raw && MATERIAL_COLOR[raw]) return MATERIAL_COLOR[raw];
  for (const [k, col] of Object.entries(MATERIAL_COLOR)) {
    if (raw.includes(k)) return col;
  }
  return KIND_COLOR[s.kind] || '#cbb79a';
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlay = 'resources';
    this.selected = null;
    this.selectedStructure = null;
    this.hover = null;
    this.terrainCache = null;
    this.cacheKey = '';
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  resize(world) {
    const { canvas } = this;
    const rect = canvas.parentElement.getBoundingClientRect();
    const cw = Math.max(320, Math.floor(rect.width));
    const chh = Math.max(220, Math.floor(rect.height));
    canvas.width = Math.floor(cw * this.dpr);
    canvas.height = Math.floor(chh * this.dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = chh + 'px';
    this.viewW = cw;
    this.viewH = chh;
    if (world) this.fit(world);
  }

  fit(world) {
    this.tile = Math.max(2, Math.min(this.viewW / world.w, this.viewH / world.h));
    this.ox = (this.viewW - this.tile * world.w) / 2;
    this.oy = (this.viewH - this.tile * world.h) / 2;
  }

  /** screen → tile */
  toTile(px, py, world) {
    return { x: Math.floor((px - this.ox) / this.tile), y: Math.floor((py - this.oy) / this.tile) };
  }

  /** tile → screen centre */
  toScreen(x, y) {
    return { x: this.ox + (x + 0.5) * this.tile, y: this.oy + (y + 0.5) * this.tile };
  }

  buildTerrain(world) {
    const { w, h } = world;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const t = world.terrain[i];
      const base = BASE[t] || [80, 80, 80];
      const f = world.fertility[i];
      const shade = 0.82 + f * 0.34;
      const o = i * 4;
      img.data[o]     = clamp(base[0] * shade, 0, 255);
      img.data[o + 1] = clamp(base[1] * shade, 0, 255);
      img.data[o + 2] = clamp(base[2] * shade, 0, 255);
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.terrainCache = c;
  }

  draw(sim, opts = {}) {
    const { world } = sim;
    const ctx = this.ctx;
    const T = this.tile;
    if (this.cacheKey !== sim.seed) { this.buildTerrain(world); this.cacheKey = sim.seed; }

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.fillStyle = '#080706';
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    // ── land ────────────────────────────────────────────────────────────
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCache, this.ox, this.oy, T * world.w, T * world.h);

    // ── time of day and weather wash ───────────────────────────────────
    const night = world.isNight ? 0.42 : 0;
    const dusk = Math.abs(world.hour - 19) < 2 || Math.abs(world.hour - 6) < 2 ? 0.16 : 0;
    if (night || dusk) {
      ctx.fillStyle = `rgba(8,10,26,${night + dusk})`;
      ctx.fillRect(this.ox, this.oy, T * world.w, T * world.h);
    }
    if (world.season === 'winter') {
      ctx.fillStyle = 'rgba(200,215,235,0.10)';
      ctx.fillRect(this.ox, this.oy, T * world.w, T * world.h);
    }
    if (world.weather === 'rain' || world.weather === 'storm') {
      ctx.fillStyle = world.weather === 'storm' ? 'rgba(30,40,60,0.26)' : 'rgba(40,55,75,0.15)';
      ctx.fillRect(this.ox, this.oy, T * world.w, T * world.h);
    }

    // ── overlays over the land ─────────────────────────────────────────
    this.drawFieldOverlay(sim);

    // ── worn paths ─────────────────────────────────────────────────────
    if (this.overlay !== 'trails') {
      ctx.fillStyle = 'rgba(196,168,120,0.30)';
      for (let i = 0; i < world.trails.length; i++) {
        const v = world.trails[i];
        if (v < 0.25) continue;
        const x = i % world.w, y = (i - (i % world.w)) / world.w;
        ctx.globalAlpha = Math.min(0.5, v * 0.4);
        ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
      }
      ctx.globalAlpha = 1;
    }

    // ── structures (footprints by kind + material color) ───────────────
    for (const s of world.structures) {
      this.drawStructure(s, T);
    }

    // selected structure ring
    const selS = this.selectedStructure;
    if (selS) {
      const p = this.toScreen(selS.x, selS.y);
      const pulse = 2 + Math.sin(performance.now() / 320) * 1.2;
      ctx.strokeStyle = '#e0a33c';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(
        p.x - T * 0.95 - pulse * 0.3,
        p.y - T * 0.95 - pulse * 0.3,
        T * 1.9 + pulse * 0.6,
        T * 1.9 + pulse * 0.6,
      );
    }

    // ── named places ───────────────────────────────────────────────────
    ctx.font = `${Math.max(9, T * 1.0)}px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const site of world.sites) {
      const p = this.toScreen(site.x, site.y);
      ctx.fillStyle = site.kind === 'graves' ? 'rgba(190,170,150,0.75)' : 'rgba(224,163,60,0.9)';
      ctx.fillText(site.name, p.x, p.y - T * 2.2);
      if (site.kind === 'graves') {
        ctx.strokeStyle = 'rgba(190,170,150,0.5)';
        ctx.lineWidth = 1;
        for (let g = 0; g < Math.min(site.graves || 0, 12); g++) {
          const gx = p.x + (g % 4 - 1.5) * T, gy = p.y + Math.floor(g / 4) * T * 1.2;
          ctx.beginPath();
          ctx.moveTo(gx, gy - T * 0.4); ctx.lineTo(gx, gy + T * 0.4);
          ctx.moveTo(gx - T * 0.25, gy - T * 0.15); ctx.lineTo(gx + T * 0.25, gy - T * 0.15);
          ctx.stroke();
        }
      }
    }

    // ── unburied dead ──────────────────────────────────────────────────
    for (const c of world.corpses) {
      const p = this.toScreen(c.x, c.y);
      ctx.fillStyle = 'rgba(160,120,110,0.8)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, T * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }

    // ── people ─────────────────────────────────────────────────────────
    const living = sim.living;
    for (const a of living) {
      const p = this.toScreen(a.x, a.y);
      const child = a.isChild(world.tick);
      const r = Math.max(1.6, T * (child ? 0.36 : 0.5));

      if (a.partner) {
        const other = sim.byId(a.partner);
        if (other && other.seq > a.seq) {
          const q = this.toScreen(other.x, other.y);
          ctx.strokeStyle = 'rgba(224,163,60,0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }

      ctx.fillStyle = this.personColor(a, sim);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      if (a.isElder(world.tick)) {
        ctx.strokeStyle = 'rgba(240,230,210,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 1.6, 0, Math.PI * 2); ctx.stroke();
      }
      if (a.body.pregnant) {
        ctx.strokeStyle = 'rgba(143,123,196,0.9)';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // ── selection and hover ────────────────────────────────────────────
    const sel = this.selected && sim.byId(this.selected);
    if (sel && sel.alive) {
      const p = this.toScreen(sel.x, sel.y);
      const pulse = 3 + Math.sin(performance.now() / 320) * 1.4;
      ctx.strokeStyle = '#e0a33c';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p.x, p.y, T * 0.5 + pulse, 0, Math.PI * 2); ctx.stroke();
      if (sel.action?.target && typeof sel.action.target.x === 'number') {
        const q = this.toScreen(sel.action.target.x, sel.action.target.y);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(224,163,60,0.5)';
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.font = `${Math.max(10, T * 1.1)}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = '#f2ece3';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sel.name, p.x, p.y - T * 1.9);
    }

    ctx.restore();
  }

  /**
   * Draw one structure as a small footprint.
   * Color from material; alpha from condition; shape from kind.
   */
  drawStructure(s, T) {
    const ctx = this.ctx;
    const p = this.toScreen(s.x, s.y);
    const cond = clamp(s.condition ?? 1, 0.15, 1);
    const col = materialColor(s);
    const half = T * 0.85;

    ctx.globalAlpha = 0.35 + cond * 0.55;
    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(10,8,6,0.65)';
    ctx.lineWidth = Math.max(1, T * 0.12);

    const kind = s.kind;
    if (kind === 'field') {
      // Tilled strips; greener when ripe
      const ripe = clamp(s.ripeness ?? 0, 0, 1);
      ctx.fillStyle = ripe > 0.5
        ? `rgba(120, 160, 60, ${0.35 + ripe * 0.4})`
        : col;
      ctx.fillRect(p.x - half, p.y - half, half * 2, half * 2);
      ctx.strokeStyle = 'rgba(40,50,20,0.45)';
      for (let i = -1; i <= 1; i++) {
        const y = p.y + i * T * 0.35;
        ctx.beginPath();
        ctx.moveTo(p.x - half * 0.85, y);
        ctx.lineTo(p.x + half * 0.85, y);
        ctx.stroke();
      }
    } else if (kind === 'bridge' || kind === 'path') {
      ctx.fillRect(p.x - half * 0.5, p.y - half, half, half * 2);
      ctx.strokeRect(p.x - half * 0.5, p.y - half, half, half * 2);
    } else if (kind === 'hearth') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, half * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // ember
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#e08a3c';
      ctx.beginPath();
      ctx.arc(p.x, p.y, half * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'well') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, half * 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#3a6a80';
      ctx.beginPath();
      ctx.arc(p.x, p.y, half * 0.35, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'shrine') {
      // upright mark
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - half);
      ctx.lineTo(p.x + half * 0.7, p.y + half * 0.6);
      ctx.lineTo(p.x - half * 0.7, p.y + half * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'hall' || kind === 'plaza' || kind === 'market') {
      ctx.fillRect(p.x - half * 1.1, p.y - half * 0.75, half * 2.2, half * 1.5);
      ctx.strokeRect(p.x - half * 1.1, p.y - half * 0.75, half * 2.2, half * 1.5);
    } else if (kind === 'store' || kind === 'workshop') {
      ctx.fillRect(p.x - half, p.y - half * 0.85, half * 2, half * 1.7);
      ctx.strokeRect(p.x - half, p.y - half * 0.85, half * 2, half * 1.7);
      // lid line
      ctx.beginPath();
      ctx.moveTo(p.x - half, p.y - half * 0.2);
      ctx.lineTo(p.x + half, p.y - half * 0.2);
      ctx.stroke();
    } else {
      // shelter and default: peaked roof silhouette
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - half);
      ctx.lineTo(p.x + half, p.y - half * 0.15);
      ctx.lineTo(p.x + half * 0.85, p.y + half);
      ctx.lineTo(p.x - half * 0.85, p.y + half);
      ctx.lineTo(p.x - half, p.y - half * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  personColor(a, sim) {
    switch (this.overlay) {
      case 'mood': {
        const m = clamp((a.affect.mood + 1) / 2, 0, 1);
        return `hsl(${Math.round(m * 120)} 62% ${45 + m * 14}%)`;
      }
      case 'hunger': {
        const hgr = clamp(a.body.hunger, 0, 1);
        return `hsl(${Math.round(90 - hgr * 90)} 70% ${52 - hgr * 10}%)`;
      }
      case 'knowledge': {
        const k = clamp(a.memory.semantic.size / 90, 0, 1);
        return `hsl(210 ${20 + k * 60}% ${34 + k * 42}%)`;
      }
      default: {
        if (a.isChild(sim.world.tick)) return '#cfe0a8';
        const role = a.role;
        return role === 'teacher' ? '#8f7bc4'
          : role === 'maker' ? '#e0a33c'
          : role === 'healer' ? '#3f9c8e'
          : role === 'hunter' ? '#d06a5a'
          : role === 'builder' ? '#c99a63'
          : role === 'farmer' ? '#6daa45'
          : role === 'forager' ? '#7a9e5c'
          : role === 'trader' ? '#c9a84c'
          : '#e6ddd0';
      }
    }
  }

  drawFieldOverlay(sim) {
    const { world } = sim;
    const ctx = this.ctx;
    const T = this.tile;
    if (this.overlay === 'resources') {
      for (const [i, bed] of world.beds) {
        const x = i % world.w, y = (i - (i % world.w)) / world.w;
        let food = 0, mat = 0;
        for (const k in bed) {
          const frac = bed[k].amount / Math.max(1, bed[k].max);
          if (k === 'berry' || k === 'root' || k === 'grain' || k === 'game') food = Math.max(food, frac);
          else mat = Math.max(mat, frac);
        }
        if (food > 0.12) {
          ctx.fillStyle = `rgba(150,214,90,${food * 0.5})`;
          ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
        } else if (mat > 0.3) {
          ctx.fillStyle = `rgba(210,190,150,${mat * 0.18})`;
          ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
        }
      }
      return;
    }
    if (this.overlay === 'trails') {
      for (let i = 0; i < world.trails.length; i++) {
        const v = world.trails[i];
        if (v < 0.05) continue;
        const x = i % world.w, y = (i - (i % world.w)) / world.w;
        ctx.fillStyle = `rgba(224,163,60,${Math.min(0.75, v * 0.5)})`;
        ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
      }
      return;
    }
    if (this.overlay === 'danger') {
      for (let i = 0; i < world.danger.length; i++) {
        const v = world.danger[i];
        if (v < 0.03) continue;
        const x = i % world.w, y = (i - (i % world.w)) / world.w;
        ctx.fillStyle = `rgba(208,106,90,${Math.min(0.7, v * 0.9)})`;
        ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
      }
    }
  }

  /** Who or what is under the pointer? */
  pick(px, py, sim) {
    const t = this.toTile(px, py, sim.world);
    let best = null, bestD = 9;
    for (const a of sim.living) {
      const d = (a.x - t.x) ** 2 + (a.y - t.y) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
    if (best) return { kind: 'person', agent: best };
    const s = sim.world.structures.find((s) => Math.abs(s.x - t.x) <= 1 && Math.abs(s.y - t.y) <= 1);
    if (s) return { kind: 'structure', structure: s };
    if (t.x >= 0 && t.y >= 0 && t.x < sim.world.w && t.y < sim.world.h) {
      const i = sim.world.idx(t.x, t.y);
      return { kind: 'tile', tile: t, terrain: TERRAIN_NAME[sim.world.terrain[i]], bed: sim.world.beds.get(i) };
    }
    return null;
  }

  legendHtml() {
    const rows = {
      none: [['#e0a33c', 'maker'], ['#8f7bc4', 'teacher'], ['#6daa45', 'farmer'], ['#7a9e5c', 'forager'], ['#d06a5a', 'hunter'], ['#3f9c8e', 'healer'], ['#cfe0a8', 'child'], ['#e6ddd0', 'unassigned']],
      resources: [['rgba(150,214,90,0.8)', 'food growing'], ['rgba(210,190,150,0.5)', 'stone, wood, clay']],
      mood: [['hsl(120 62% 56%)', 'content'], ['hsl(60 62% 50%)', 'unsettled'], ['hsl(0 62% 46%)', 'wretched']],
      hunger: [['hsl(90 70% 52%)', 'fed'], ['hsl(0 70% 44%)', 'starving']],
      knowledge: [['hsl(210 80% 74%)', 'knows much'], ['hsl(210 20% 34%)', 'knows little']],
      trails: [['rgba(224,163,60,0.7)', 'well-worn ground']],
      danger: [['rgba(208,106,90,0.7)', 'where harm happened']],
    }[this.overlay] || [];
    const extra = '<div class="legend-row" style="margin-top:6px;opacity:0.8"><span class="legend-dot" style="background:none;border:1px solid rgba(240,230,210,0.6)"></span>elder</div>'
      + '<div class="legend-row" style="opacity:0.8"><span class="legend-dot" style="background:none;border:1px solid #8f7bc4"></span>expecting</div>';
    return rows.map(([c, l]) => `<div class="legend-row"><span class="legend-dot" style="background:${c}"></span>${l}</div>`).join('') + extra;
  }
}
