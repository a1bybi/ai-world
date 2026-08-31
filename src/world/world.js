// The land itself: procedurally grown terrain, renewable resource beds, a
// climate that turns, and whatever the inhabitants choose to build on top.
//
// Structures can change movement: bridges cross water; paths and worn trails
// are cheaper to walk. Fauna herds wander and sync into game beds for hunt.

import { clamp, lerp } from '../core/util.js';

export const TERRAIN = {
  DEEP: 0, WATER: 1, MARSH: 2, MEADOW: 3, GRASS: 4,
  FOREST: 5, HILL: 6, ROCK: 7, SAND: 8,
};
export const TERRAIN_NAME = [
  'deep water', 'water', 'marsh', 'meadow', 'grass',
  'forest', 'hill', 'rock', 'sand',
];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

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
  const gw = Math.ceil(w / scale) + 2;
  const gh = Math.ceil(h / scale) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / scale;
      const gy = y / scale;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
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
    this.beds = new Map();
    this.structures = [];
    this.corpses = [];
    this.sites = [];
    this.trails = new Float32Array(width * height);
    this.danger = new Float32Array(width * height);
    this.structureIndex = new Map();
    this.fauna = [];
    this.season = 'spring';
    this.weather = 'clear';
    this.temperature = 0.55;
    this.generate();
  }

  idx(x, y) {
    return y * this.w + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  at(x, y) {
    return this.terrain[this.idx(x, y)];
  }

  /**
   * Land is always walkable (except DEEP).
   * WATER / MARSH only if this tile has a bridge (or an adjacent bridge
   * for a 1-tile “approach” so pathing can step onto the span).
   */
  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const t = this.at(x, y);
    if (t === TERRAIN.DEEP) return false;
    if (t === TERRAIN.WATER || t === TERRAIN.MARSH) {
      return this.hasBridgeAccess(x, y);
    }
    return true;
  }

  hasBridgeAccess(x, y) {
    const here = this.structureAt(x, y);
    if (here && here.kind === 'bridge') return true;
    // Allow stepping onto water that touches a bridge (crossing a narrow span)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = this.structureAt(x + dx, y + dy);
      if (s && s.kind === 'bridge') return true;
    }
    return false;
  }

  moveCost(x, y) {
    if (!this.inBounds(x, y)) return 99;
    const t = this.at(x, y);
    if (t === TERRAIN.DEEP) return 99;
    if ((t === TERRAIN.WATER || t === TERRAIN.MARSH) && !this.hasBridgeAccess(x, y)) {
      return 99;
    }

    let cost = 1;
    if (t === TERRAIN.FOREST) cost = 1.15;
    else if (t === TERRAIN.HILL) cost = 1.2;
    else if (t === TERRAIN.ROCK) cost = 1.25;
    else if (t === TERRAIN.MARSH) cost = 1.1;

    const s = this.structureAt(x, y);
    if (s) {
      if (s.kind === 'path' || s.kind === 'road') cost *= 0.65;
      if (s.kind === 'bridge') cost *= 0.85;
      if (s.kind === 'plaza' || s.kind === 'hall') cost *= 0.85;
    }

    const trail = this.trails[this.idx(x, y)] || 0;
    if (trail > 0.15) cost *= 1 - clamp(trail * 0.35, 0, 0.35);

    return cost;
  }

  structuresNear(x, y, radius = 6, kind = null) {
    const r2 = radius * radius;
    return this.structures.filter((s) => {
      if (kind && s.kind !== kind) return false;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      return d <= r2;
    });
  }

  hasStructureNear(x, y, kind, radius = 6) {
    return this.structuresNear(x, y, radius, kind).length > 0;
  }

  /**
   * Candidate bridge placements near a camp.
   * Water/marsh tile with ≥1 dry land neighbor, not too close to an existing bridge.
   * Ranked by: closeness to center, then “cross potential” (land on opposite sides).
   */
  findBridgeSites(cx, cy, radius = 22, minSpacing = 4, limit = 12) {
    const scored = [];
    const r0 = Math.max(0, (cx | 0) - radius);
    const r1 = Math.min(this.w - 1, (cx | 0) + radius);
    const c0 = Math.max(0, (cy | 0) - radius);
    const c1 = Math.min(this.h - 1, (cy | 0) + radius);

    for (let y = c0; y <= c1; y++) {
      for (let x = r0; x <= r1; x++) {
        const t = this.at(x, y);
        if (t !== TERRAIN.WATER && t !== TERRAIN.MARSH) continue;
        if (this.structureAt(x, y)) continue;

        let landN = 0;
        let landS = 0;
        let landE = 0;
        let landW = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nt = this.at(nx, ny);
          if (nt > TERRAIN.MARSH) {
            if (dx === 1) landE++;
            if (dx === -1) landW++;
            if (dy === 1) landS++;
            if (dy === -1) landN++;
          }
        }
        const landAdj = landN + landS + landE + landW;
        if (landAdj < 1) continue;

        const tooClose = this.structuresOfKind('bridge').some(
          (b) => Math.hypot(b.x - x, b.y - y) < minSpacing,
        );
        if (tooClose) continue;

        // Prefer spans that touch two opposite banks (real crossing)
        const opposite =
          (landE && landW ? 2 : 0) + (landN && landS ? 2 : 0) + landAdj * 0.15;
        const distCamp = Math.hypot(x - cx, y - cy);
        const score = opposite * 3 - distCamp * 0.08 + landAdj * 0.2;
        scored.push({ x, y, score, landAdj, opposite });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Count water/marsh tiles near a point (for settlementNeeds). */
  waterNearCount(cx, cy, radius = 10) {
    let n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (cx | 0) + dx;
        const y = (cy | 0) + dy;
        if (!this.inBounds(x, y)) continue;
        const t = this.at(x, y);
        if (t === TERRAIN.WATER || t === TERRAIN.MARSH) n++;
      }
    }
    return n;
  }

  generate() {
    const { rng, w, h } = this;
    const elev = valueNoise(rng, w, h, 13);
    const moist = valueNoise(rng, w, h, 9);
    const detail = valueNoise(rng, w, h, 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = this.idx(x, y);
        const nx = (x / w) * 2 - 1;
        const ny = (y / h) * 2 - 1;
        const fall = 1 - clamp(Math.hypot(nx * 0.95, ny * 1.05), 0, 1) ** 2.1;
        const e = clamp(elev[i] * 0.65 + detail[i] * 0.35) * 0.55 + fall * 0.6;
        const m = clamp(moist[i] * 0.7 + detail[i] * 0.3);
        let t;
        if (e < 0.3) t = TERRAIN.DEEP;
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
    this.seedFauna(18);
    this.syncFaunaBeds();
  }

  carveRiver() {
    const { rng, w, h } = this;
    for (let r = 0; r < 2; r++) {
      let x = rng.int(Math.floor(w * 0.25), Math.floor(w * 0.75));
      let y = rng.int(2, 6);
      let dx = rng.float(-0.4, 0.4);
      for (let step = 0; step < h * 1.6; step++) {
        dx = clamp(dx + rng.float(-0.35, 0.35), -0.9, 0.9);
        x += dx;
        y += 1;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (!this.inBounds(ix, iy)) break;
        for (let oy = 0; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!this.inBounds(ix + ox, iy + oy)) continue;
            const i = this.idx(ix + ox, iy + oy);
            if (this.terrain[i] !== TERRAIN.DEEP) {
              this.terrain[i] =
                Math.abs(ox) === 1 && rng.bool(0.4) ? TERRAIN.MARSH : TERRAIN.WATER;
            }
            this.fertility[i] = clamp(this.fertility[i] + 0.25);
          }
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
          const slow = key === 'stone' || key === 'ore' ? 0.15 : key === 'game' ? 0.5 : 1;
          const edible = key === 'berry' || key === 'root' || key === 'grain';
          bed[key] = {
            amount: max * rng.float(0.5, 1),
            max,
            regrow: 0.009 * density * slow * (edible ? 6 : 1),
          };
        }
        if (Object.keys(bed).length) this.beds.set(i, bed);
      }
    }
    this.indexBeds();
  }

  indexBeds() {
    this.cell = 8;
    this.cw = Math.ceil(this.w / this.cell);
    this.ch = Math.ceil(this.h / this.cell);
    this.bedIndex = new Map();
    for (const [i, bed] of this.beds) {
      const x = i % this.w;
      const y = (i - (i % this.w)) / this.w;
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

  seedFauna(count = 18) {
    this.fauna = [];
    const { rng, w, h } = this;
    let tries = 0;
    while (this.fauna.length < count && tries < count * 40) {
      tries++;
      const x = rng.int(2, w - 3);
      const y = rng.int(2, h - 3);
      const t = this.at(x, y);
      if (t !== TERRAIN.MEADOW && t !== TERRAIN.GRASS && t !== TERRAIN.FOREST) continue;
      this.fauna.push({
        id: `f${this.fauna.length}`,
        x,
        y,
        kind: rng.bool(0.55) ? 'herd' : 'pack',
        size: 2 + Math.floor(rng.float(1, 5)),
        energy: 1,
      });
    }
  }

  syncFaunaBeds() {
    for (const [, bed] of this.beds) {
      if (bed.game && bed.game._mobile) {
        bed.game.amount = 0;
      }
    }
    for (const f of this.fauna || []) {
      if (f.size < 0.5) continue;
      const i = this.idx(f.x | 0, f.y | 0);
      let bed = this.beds.get(i);
      if (!bed) {
        bed = {};
        this.beds.set(i, bed);
      }
      const amount = f.size * (f.kind === 'pack' ? 1.4 : 1);
      bed.game = {
        amount,
        max: amount + 2,
        regrow: 0,
        _mobile: true,
      };
    }
    if (this.bedIndex) {
      const m = this.bedIndex.get('game') || new Map();
      m.clear();
      for (const [i, bed] of this.beds) {
        if (!bed.game || bed.game.amount < 1) continue;
        const x = i % this.w;
        const y = (i - x) / this.w;
        const ci = Math.floor(y / this.cell) * this.cw + Math.floor(x / this.cell);
        let list = m.get(ci);
        if (!list) m.set(ci, (list = []));
        list.push(i);
      }
      this.bedIndex.set('game', m);
    }
  }

  stepFauna(dt = 1) {
    if (!this.fauna?.length) return;
    const { rng } = this;
    for (const f of this.fauna) {
      if (this.tick % 3 !== 0) continue;
      let best = null;
      let bestScore = -Infinity;
      for (let n = 0; n < 6; n++) {
        const nx = clamp((f.x | 0) + rng.int(-2, 2), 1, this.w - 2);
        const ny = clamp((f.y | 0) + rng.int(-2, 2), 1, this.h - 2);
        if (!this.walkable(nx, ny)) continue;
        const t = this.at(nx, ny);
        let score = this.fertility[this.idx(nx, ny)] || 0;
        if (t === TERRAIN.MEADOW) score += 0.4;
        if (t === TERRAIN.GRASS) score += 0.25;
        if (t === TERRAIN.FOREST) score += 0.1;
        if (score > bestScore) {
          bestScore = score;
          best = { x: nx, y: ny };
        }
      }
      if (best) {
        f.x = best.x;
        f.y = best.y;
      }
      if (this.season !== 'winter' && rng.bool(0.02 * f.size)) {
        f.size = Math.min(8, f.size + 0.15);
      }
      if (this.season === 'winter') f.size = Math.max(1, f.size - 0.02 * dt);
    }
    this.fauna = this.fauna.filter((f) => f.size >= 0.5);
    this.syncFaunaBeds();
  }

  harvestFaunaAt(x, y, amount) {
    const fx = x | 0;
    const fy = y | 0;
    let remaining = amount;
    for (const f of this.fauna || []) {
      if ((f.x | 0) !== fx || (f.y | 0) !== fy) continue;
      const take = Math.min(f.size, remaining);
      f.size -= take;
      remaining -= take;
      if (remaining <= 0) break;
    }
    this.fauna = this.fauna.filter((f) => f.size >= 0.5);
  }

  buildWaterField() {
    const n = this.w * this.h;
    this.waterFrom = new Int32Array(n).fill(-1);
    const q = [];
    for (let i = 0; i < n; i++) {
      const t = this.terrain[i];
      if (t === TERRAIN.WATER || t === TERRAIN.MARSH) {
        this.waterFrom[i] = i;
        q.push(i);
      }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % this.w;
      const y = (i - x) / this.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
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

  bedAt(x, y) {
    return this.beds.get(this.idx(x, y));
  }

  findResource(key, from, radius = 18) {
    const m = this.bedIndex?.get(key);
    if (!m) return null;
    const cell = this.cell;
    const cx = Math.floor(from.x / cell);
    const cy = Math.floor(from.y / cell);
    const rings = Math.ceil(radius / cell);
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r <= rings; r++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= this.ch) continue;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (gx < 0 || gx >= this.cw) continue;
          if (r > 0 && Math.abs(gy - cy) !== r && Math.abs(gx - cx) !== r) continue;
          const list = m.get(gy * this.cw + gx);
          if (!list) continue;
          for (const i of list) {
            const bed = this.beds.get(i);
            if (!bed || !bed[key] || bed[key].amount < 1) continue;
            const x = i % this.w;
            const y = (i - (i % this.w)) / this.w;
            const d = (x - from.x) ** 2 + (y - from.y) ** 2;
            if (d < bestD && d <= radius * radius) {
              bestD = d;
              best = { x, y, amount: bed[key].amount };
            }
          }
        }
      }
      if (best) break;
    }
    return best;
  }

  harvest(x, y, key, amount) {
    const bed = this.beds.get(this.idx(x, y));
    if (!bed || !bed[key]) return 0;
    const got = Math.min(bed[key].amount, amount);
    bed[key].amount -= got;
    if (key === 'game') this.harvestFaunaAt(x, y, got);
    return got;
  }

  addStructure(s) {
    this.structures.push(s);
    const i = this.idx(s.x, s.y);
    this.structureIndex.set(i, s);
    this.trails[i] = 1;
    if (s.kind === 'bridge' || s.kind === 'path' || s.kind === 'road') {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.inBounds(s.x + dx, s.y + dy)) continue;
        const j = this.idx(s.x + dx, s.y + dy);
        this.trails[j] = clamp(this.trails[j] + 0.35, 0, 1);
      }
    }
    return s;
  }

  structureAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    return this.structureIndex.get(this.idx(x, y)) || null;
  }

  structuresOfKind(kind) {
    return this.structures.filter((s) => s.kind === kind);
  }

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
      this.weather =
        roll < 0.06 ? 'storm' : roll < 0.24 ? 'rain' : roll < 0.34 ? 'overcast' : 'clear';
    }
    const growth =
      (this.weather === 'rain' ? 1.5 : this.weather === 'storm' ? 1.2 : 1) *
      (0.35 + seasonal);

    const keys = [...this.beds.keys()];
    const sampleCount = Math.max(1, Math.floor(keys.length / 6));
    for (let n = 0; n < sampleCount; n++) {
      const i = keys[(this.tick * 7 + n * 6) % keys.length];
      const bed = this.beds.get(i);
      for (const r of Object.values(bed)) {
        if (r._mobile) continue;
        r.amount = Math.min(r.max, r.amount + r.regrow * growth * 6 * dt);
      }
    }
    for (let i = 0; i < this.trails.length; i += 3) {
      const j = (i + this.tick) % this.trails.length;
      this.trails[j] *= 0.9995;
      this.danger[j] *= 0.998;
    }

    this.stepFauna(dt);
  }

  get dayNumber() {
    return Math.floor(this.tick / 24) + 1;
  }

  get hour() {
    return this.tick % 24;
  }

  timeString() {
    const h = String(Math.floor(this.hour)).padStart(2, '0');
    return `Day ${this.dayNumber} · ${h}:00`;
  }

  get year() {
    return Math.floor(this.tick / (24 * 30)) + 1;
  }
}
