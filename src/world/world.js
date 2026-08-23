// The land itself: procedurally grown terrain, renewable resource beds, a
// climate that turns, and whatever the inhabitants choose to build on top.

import { clamp, lerp } from '../core/util.js';

export const TERRAIN = { DEEP: 0, WATER: 1, MARSH: 2, MEADOW: 3, GRASS: 4, FOREST: 5, HILL: 6, ROCK: 7, SAND: 8 };
export const TERRAIN_NAME = ['deep water', 'water', 'marsh', 'meadow', 'grass', 'forest', 'hill', 'rock', 'sand'];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

// Which raw matter a terrain type can yield, and how fast it comes back.
const YIELDS = {
  [TERRAIN.WATER]:  { water: 1.0, clay: 0.5, reed: 0.6 },
  [TERRAIN.MARSH]:  { reed: 0.9, clay: 0.8, water: 0.7, root: 0.3 },
  [TERRAIN.MEADOW]: { grain: 0.9, fibre: 0.8, root: 0.7, berry: 0.3, game: 0.3 },
  [TERRAIN.GRASS]:  { fibre: 0.5, root: 0.4, grain: 0.3, game: 0.35 },
  [TERRAIN.FOREST]: { wood: 1.0, berry: 0.8, resin: 0.5, root: 0.3, game: 0.25 },
  [TERRAIN.HILL]:   { stone: 0.7, ore: 0.3, fibre: 0.2 },
  [TERRAIN.ROCK]:   { stone: 1.0, ore: 0.7 },
  [TERRAIN.SAND]:   { stone: 0.2, clay: 0.3 },
};

function valueNoise(rng, w, h, scale) {
  const gw = Math.ceil(w / scale) + 2, gh = Math.ceil(h / scale) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / scale, gy = y / scale;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const tx = gx - x0, ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
    }
  }
  return out;
}

export class World {
  constructor(rng, { width = 104, height = 68 } = {}) {
    this.rng = rng;
    this.w = width;
    this.h = height;
    this.tick = 0;
    this.terrain = new Uint8Array(width * height);
    this.fertility = new Float32Array(width * height);
    this.beds = new Map();            // tileIndex -> { key -> {amount, max, regrow} }
    this.structures = [];
    this.corpses = [];
    this.sites = [];                  // named places: settlement, grave field, market, shrine
    this.trails = new Float32Array(width * height); // worn paths from footfall
    this.danger = new Float32Array(width * height);
    this.season = 'spring';
    this.weather = 'clear';
    this.temperature = 0.55;
    this.generate();
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  at(x, y) { return this.terrain[this.idx(x, y)]; }
  walkable(x, y) { return this.inBounds(x, y) && this.at(x, y) > TERRAIN.WATER; }

  generate() {
    const { rng, w, h } = this;
    const elev = valueNoise(rng, w, h, 13);
    const moist = valueNoise(rng, w, h, 9);
    const detail = valueNoise(rng, w, h, 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.idx(x, y);
        // Island-ish falloff so the world has edges and coasts.
        const nx = (x / w) * 2 - 1, ny = (y / h) * 2 - 1;
        const fall = 1 - clamp(Math.hypot(nx * 0.95, ny * 1.05), 0, 1) ** 2.1;
        const e = clamp(elev[i] * 0.65 + detail[i] * 0.35) * 0.55 + fall * 0.6;
        const m = clamp(moist[i] * 0.7 + detail[i] * 0.3);
        let t;
        if (e < 0.30) t = TERRAIN.DEEP;
        else if (e < 0.38) t = TERRAIN.WATER;
        else if (e < 0.42) t = m > 0.55 ? TERRAIN.MARSH : TERRAIN.SAND;
        else if (e < 0.62) t = m > 0.62 ? TERRAIN.FOREST : m > 0.36 ? TERRAIN.MEADOW : TERRAIN.GRASS;
        else if (e < 0.74) t = m > 0.5 ? TERRAIN.FOREST : TERRAIN.HILL;
        else t = TERRAIN.ROCK;
        this.terrain[i] = t;
        this.fertility[i] = clamp(m * 0.7 + (1 - Math.abs(e - 0.5)) * 0.5);
      }
    }
    this.carveRiver();
    this.seedBeds();
  }

  carveRiver() {
    const { rng, w, h } = this;
    for (let r = 0; r < 2; r++) {
      let x = rng.int(Math.floor(w * 0.25), Math.floor(w * 0.75));
      let y = rng.int(2, 6);
      let dx = rng.float(-0.4, 0.4);
      for (let step = 0; step < h * 1.6; step++) {
        dx = clamp(dx + rng.float(-0.35, 0.35), -0.9, 0.9);
        x += dx; y += 1;
        const ix = Math.round(x), iy = Math.round(y);
        if (!this.inBounds(ix, iy)) break;
        for (let oy = 0; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (!this.inBounds(ix + ox, iy + oy)) continue;
          const i = this.idx(ix + ox, iy + oy);
          if (this.terrain[i] !== TERRAIN.DEEP) this.terrain[i] = Math.abs(ox) === 1 && rng.bool(0.4) ? TERRAIN.MARSH : TERRAIN.WATER;
          this.fertility[i] = clamp(this.fertility[i] + 0.25);
        }
      }
    }
  }

  seedBeds() {
    const { rng, w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.idx(x, y);
        const y2 = YIELDS[this.terrain[i]];
        if (!y2) continue;
        const bed = {};
        for (const [key, density] of Object.entries(y2)) {
          if (!rng.bool(density * 0.55)) continue;
          const max = 6 + Math.round(density * this.fertility[i] * 22 * rng.float(0.6, 1.4));
          const slow = (key === 'stone' || key === 'ore') ? 0.15 : key === 'game' ? 0.5 : 1;
          const edible = key === 'berry' || key === 'root' || key === 'grain';
          bed[key] = { amount: max * rng.float(0.5, 1), max, regrow: 0.009 * density * slow * (edible ? 6 : 1) };
        }
        if (Object.keys(bed).length) this.beds.set(i, bed);
      }
    }
    this.indexBeds();
  }

  /** Coarse spatial index so "where is the nearest stone?" is a handful of checks
   *  rather than a sweep of the whole map, every person, every hour. */
  indexBeds() {
    this.cell = 8;
    this.cw = Math.ceil(this.w / this.cell);
    this.ch = Math.ceil(this.h / this.cell);
    this.bedIndex = new Map();          // key -> Map(cellIdx -> [tileIdx])
    for (const [i, bed] of this.beds) {
      const x = i % this.w, y = (i - (i % this.w)) / this.w;
      const ci = Math.floor(y / this.cell) * this.cw + Math.floor(x / this.cell);
      for (const key of Object.keys(bed)) {
        let m = this.bedIndex.get(key);
        if (!m) this.bedIndex.set(key, (m = new Map()));
        let list = m.get(ci);
        if (!list) m.set(ci, (list = []));
        list.push(i);
      }
    }
  }

  /** Breadth-first field: for any land tile, the nearest drinkable tile. Water is
   *  never hidden from a thirsty person — finding it is a matter of walking. */
  buildWaterField() {
    const n = this.w * this.h;
    this.waterFrom = new Int32Array(n).fill(-1);
    const q = [];
    for (let i = 0; i < n; i++) {
      const t = this.terrain[i];
      if (t === TERRAIN.WATER || t === TERRAIN.MARSH) { this.waterFrom[i] = i; q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % this.w, y = (i - x) / this.w;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const j = this.idx(nx, ny);
        if (this.waterFrom[j] !== -1 || this.terrain[j] === TERRAIN.DEEP) continue;
        this.waterFrom[j] = this.waterFrom[i];
        q.push(j);
      }
    }
  }

  nearestWater(x, y) {
    if (!this.waterFrom) this.buildWaterField();
    const i = this.waterFrom[this.idx(x, y)];
    if (i < 0) return null;
    const wx = i % this.w;
    return { x: wx, y: (i - wx) / this.w };
  }

  bedAt(x, y) { return this.beds.get(this.idx(x, y)); }

  /** Find the nearest tile offering a resource the agent can perceive. */
  findResource(key, from, radius = 18) {
    const m = this.bedIndex?.get(key);
    if (!m) return null;
    const cell = this.cell;
    const cx = Math.floor(from.x / cell), cy = Math.floor(from.y / cell);
    const rings = Math.ceil(radius / cell);
    let best = null, bestD = Infinity;
    for (let r = 0; r <= rings; r++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= this.ch) continue;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (gx < 0 || gx >= this.cw) continue;
          if (r > 0 && Math.abs(gy - cy) !== r && Math.abs(gx - cx) !== r) continue;  // ring only
          const list = m.get(gy * this.cw + gx);
          if (!list) continue;
          for (const i of list) {
            const bed = this.beds.get(i);
            if (!bed || !bed[key] || bed[key].amount < 1) continue;
            const x = i % this.w, y = (i - (i % this.w)) / this.w;
            const d = (x - from.x) ** 2 + (y - from.y) ** 2;
            if (d < bestD && d <= radius * radius) { bestD = d; best = { x, y, amount: bed[key].amount }; }
          }
        }
      }
      if (best) break;   // nearest ring with a hit is good enough
    }
    return best;
  }

  harvest(x, y, key, amount) {
    const bed = this.beds.get(this.idx(x, y));
    if (!bed || !bed[key]) return 0;
    const got = Math.min(bed[key].amount, amount);
    bed[key].amount -= got;
    return got;
  }

  addStructure(s) {
    this.structures.push(s);
    const i = this.idx(s.x, s.y);
    this.trails[i] = 1;
    return s;
  }

  structureAt(x, y) { return this.structures.find((s) => s.x === x && s.y === y); }
  structuresOfKind(kind) { return this.structures.filter((s) => s.kind === kind); }

  step(dt = 1) {
    this.tick += dt;
    const dayOfYear = (this.tick / 24) % 60;
    const s = Math.floor((dayOfYear / 60) * 4);
    this.season = SEASONS[s];
    const seasonal = [0.6, 0.9, 0.55, 0.15][s];
    const hour = this.tick % 24;
    const diurnal = 0.5 - Math.cos((hour / 24) * Math.PI * 2) * 0.5;
    this.temperature = clamp(seasonal * 0.75 + diurnal * 0.25);
    this.isNight = hour < 6 || hour >= 20;

    if (this.tick % 6 === 0) {
      const roll = this.rng.next();
      this.weather = roll < 0.06 ? 'storm' : roll < 0.24 ? 'rain' : roll < 0.34 ? 'overcast' : 'clear';
    }
    const growth = (this.weather === 'rain' ? 1.5 : this.weather === 'storm' ? 1.2 : 1) * (0.35 + seasonal);

    // Resource regrowth, sampled so huge maps stay cheap.
    const keys = [...this.beds.keys()];
    const sampleCount = Math.max(1, Math.floor(keys.length / 6));
    for (let n = 0; n < sampleCount; n++) {
      const i = keys[(this.tick * 7 + n * 6) % keys.length];
      const bed = this.beds.get(i);
      for (const r of Object.values(bed)) r.amount = Math.min(r.max, r.amount + r.regrow * growth * 6 * dt);
    }
    for (let i = 0; i < this.trails.length; i += 3) {
      const j = (i + this.tick) % this.trails.length;
      this.trails[j] *= 0.9995;
      this.danger[j] *= 0.998;
    }
  }

  get dayNumber() { return Math.floor(this.tick / 24) + 1; }
  get hour() { return this.tick % 24; }
  timeString() {
    const h = String(Math.floor(this.hour)).padStart(2, '0');
    return `Day ${this.dayNumber} · ${h}:00`;
  }
  get year() { return Math.floor(this.tick / (24 * 30)) + 1; }
}
