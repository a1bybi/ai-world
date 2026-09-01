// The land: terrain, beds, climate, fauna, structures, terraforming,
// and bridges grown one water/marsh tile at a time.

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

const FAUNA_KINDS = {
  deer:  { speed: 1, yield: 2, prefer: [TERRAIN.MEADOW, TERRAIN.GRASS, TERRAIN.FOREST] },
  boar:  { speed: 1, yield: 2.5, prefer: [TERRAIN.FOREST, TERRAIN.GRASS] },
  fowl:  { speed: 2, yield: 1, prefer: [TERRAIN.MARSH, TERRAIN.MEADOW, TERRAIN.WATER] },
  fish:  { speed: 0, yield: 1.5, prefer: [TERRAIN.WATER, TERRAIN.DEEP] },
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
      const fx = gx - x0;
      const fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const i00 = y0 * gw + x0;
      const a = lerp(grid[i00], grid[i00 + 1], sx);
      const b = lerp(grid[i00 + gw], grid[i00 + gw + 1], sx);
      out[y * w + x] = lerp(a, b, sy);
    }
  }
  return out;
}

export class World {
  constructor(rng, opts = {}) {
    this.rng = rng;
    this.w = opts.w || 64;
    this.h = opts.h || 48;
    this.tick = 0;
    this.season = 'spring';
    this.temperature = 0.55;
    this.isNight = false;
    this.weather = 'clear';

    this.terrain = new Uint8Array(this.w * this.h);
    this.elev = new Float32Array(this.w * this.h);
    this.moist = new Float32Array(this.w * this.h);
    this.fertility = new Float32Array(this.w * this.h);
    this.trails = new Float32Array(this.w * this.h);
    this.danger = new Float32Array(this.w * this.h);

    this.beds = new Map();
    this.structures = [];
    this.sites = [];
    this.corpses = [];
    this.fauna = [];
    this._nextFaunaId = 1;
    this._riverCells = [];
    this.terraformLog = [];

    this.generate();
  }

  idx(x, y) {
    return (y | 0) * this.w + (x | 0);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  at(x, y) {
    if (!this.inBounds(x, y)) return TERRAIN.DEEP;
    return this.terrain[this.idx(x, y)];
  }

  // ── Generation ────────────────────────────────────────────────

  generate() {
    const { w, h, rng } = this;
    const elev = valueNoise(rng, w, h, 10);
    const moist = valueNoise(rng, w, h, 8);
    const detail = valueNoise(rng, w, h, 4);

    for (let i = 0; i < w * h; i++) {
      this.elev[i] = elev[i] * 0.7 + detail[i] * 0.3;
      this.moist[i] = moist[i];
      this.fertility[i] = clamp(
        0.35 + moist[i] * 0.45 + (1 - Math.abs(elev[i] - 0.45)) * 0.2,
      );
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edge = Math.min(x, y, w - 1 - x, h - 1 - y) / Math.min(w, h);
        this.elev[this.idx(x, y)] *= 0.55 + edge * 1.1;
      }
    }

    this.carveRiver();

    for (let i = 0; i < w * h; i++) {
      const e = this.elev[i];
      const m = this.moist[i];
      let t;
      if (e < 0.22) t = TERRAIN.DEEP;
      else if (e < 0.32) t = TERRAIN.WATER;
      else if (e < 0.38 && m > 0.55) t = TERRAIN.MARSH;
      else if (e > 0.78) t = TERRAIN.ROCK;
      else if (e > 0.68) t = TERRAIN.HILL;
      else if (m < 0.28) t = TERRAIN.SAND;
      else if (m > 0.62 && e < 0.55) t = TERRAIN.FOREST;
      else if (m > 0.45) t = TERRAIN.MEADOW;
      else t = TERRAIN.GRASS;
      this.terrain[i] = t;
    }

    for (const i of this._riverCells) {
      if (this.terrain[i] > TERRAIN.MARSH) this.terrain[i] = TERRAIN.WATER;
    }

    this.seedBeds();
    this.seedFauna();
  }

  carveRiver() {
    const { w, h, rng } = this;
    this._riverCells = [];
    let x = rng.int(Math.floor(w * 0.25), Math.floor(w * 0.75));
    let y = 0;
    const cells = new Set();
    while (y < h) {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = 0; oy <= 1; oy++) {
          const nx = x + ox;
          const ny = y + oy;
          if (!this.inBounds(nx, ny)) continue;
          const i = this.idx(nx, ny);
          cells.add(i);
          this.elev[i] = Math.min(this.elev[i], 0.26);
          this.moist[i] = Math.max(this.moist[i], 0.75);
        }
      }
      x += rng.int(-1, 1);
      x = clamp(x, 2, w - 3);
      y += rng.bool(0.7) ? 1 : 0;
      if (y >= h) break;
      if (rng.bool(0.15)) y++;
    }
    this._riverCells = [...cells];
  }

  seedBeds() {
    this.beds.clear();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const t = this.at(x, y);
        const table = YIELDS[t];
        if (!table) continue;
        const bed = {};
        for (const [res, rate] of Object.entries(table)) {
          if (res === 'game') continue;
          const max = 4 + rate * 10;
          bed[res] = {
            amount: max * (0.4 + this.rng.next() * 0.6),
            max,
            regrow: 0.002 + rate * 0.006,
          };
        }
        if (Object.keys(bed).length) this.beds.set(this.idx(x, y), bed);
      }
    }
  }

  // ── Fauna (visible, harvestable, seasonal) ────────────────────

  seedFauna() {
    this.fauna = [];
    const area = this.w * this.h;
    const counts = {
      deer: Math.floor(area / 100),
      boar: Math.floor(area / 140),
      fowl: Math.floor(area / 120),
      fish: Math.floor(area / 90),
    };
    for (const [kind, n] of Object.entries(counts)) {
      const pref = FAUNA_KINDS[kind].prefer;
      let placed = 0;
      let tries = 0;
      while (placed < n && tries < n * 20) {
        tries++;
        const x = this.rng.int(1, this.w - 2);
        const y = this.rng.int(1, this.h - 2);
        const t = this.at(x, y);
        if (!pref.includes(t)) continue;
        this.spawnFauna(kind, x, y);
        placed++;
      }
    }
  }

  spawnFauna(kind, x, y) {
    const def = FAUNA_KINDS[kind] || FAUNA_KINDS.deer;
    const f = {
      id: `f${this._nextFaunaId++}`,
      kind,
      x: x | 0,
      y: y | 0,
      energy: 0.5 + this.rng.next() * 0.5,
      age: this.rng.float(0, 1),
      yield: def.yield,
    };
    this.fauna.push(f);
    this.syncGameBed(f.x, f.y);
    return f;
  }

  syncGameBed(x, y) {
    const i = this.idx(x, y);
    let bed = this.beds.get(i);
    if (!bed) {
      bed = {};
      this.beds.set(i, bed);
    }
    const here = this.fauna.filter((f) => f.x === x && f.y === y && f.kind !== 'fish').length;
    const fishHere = this.fauna.filter((f) => f.x === x && f.y === y && f.kind === 'fish').length;
    if (here > 0) {
      bed.game = {
        amount: Math.max(bed.game?.amount || 0, here * 0.8),
        max: Math.max(3, here * 2),
        regrow: 0.0012,
      };
    }
    if (fishHere > 0) {
      bed.fish = {
        amount: Math.max(bed.fish?.amount || 0, fishHere),
        max: Math.max(2, fishHere * 2),
        regrow: 0.002,
      };
    }
  }

  faunaAt(x, y) {
    return this.fauna.filter((f) => f.x === (x | 0) && f.y === (y | 0));
  }

  removeFauna(f) {
    const i = this.fauna.indexOf(f);
    if (i >= 0) this.fauna.splice(i, 1);
    this.syncGameBed(f.x, f.y);
  }

  stepFauna() {
    const seasonal =
      this.season === 'winter' ? 0.55 :
      this.season === 'spring' ? 1.15 : 1;

    for (const f of [...this.fauna]) {
      f.age += 0.0003;
      f.energy = clamp(f.energy - 0.01 + seasonal * 0.012);

      // Die of age / starvation rarely
      if (f.age > 1.2 || f.energy < 0.05) {
        if (this.rng.bool(0.15)) this.removeFauna(f);
        continue;
      }

      // Breed slowly on good tiles
      if (
        f.energy > 0.7 &&
        f.age > 0.25 &&
        f.age < 0.9 &&
        this.fauna.length < (this.w * this.h) / 40 &&
        this.rng.bool(0.008 * seasonal)
      ) {
        this.spawnFauna(f.kind, f.x, f.y);
      }

      const def = FAUNA_KINDS[f.kind] || FAUNA_KINDS.deer;
      if (def.speed <= 0) continue;
      if (!this.rng.bool(0.35 * def.speed)) continue;

      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      const d = dirs[this.rng.int(0, dirs.length - 1)];
      const nx = clamp(f.x + d[0], 1, this.w - 2);
      const ny = clamp(f.y + d[1], 1, this.h - 2);
      const t = this.at(nx, ny);
      if (f.kind === 'fish') {
        if (t === TERRAIN.WATER || t === TERRAIN.DEEP || t === TERRAIN.MARSH) {
          f.x = nx;
          f.y = ny;
        }
      } else if (t > TERRAIN.MARSH && t < TERRAIN.ROCK) {
        const prefer = def.prefer.includes(t) ? 1 : 0.35;
        if (this.rng.bool(prefer)) {
          const ox = f.x;
          const oy = f.y;
          f.x = nx;
          f.y = ny;
          this.syncGameBed(ox, oy);
          this.syncGameBed(nx, ny);
        }
      }
    }
  }

  // ── Structures ────────────────────────────────────────────────

  structureAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    return this.structures.find((s) => s.x === (x | 0) && s.y === (y | 0)) || null;
  }

  structuresOfKind(kind) {
    return this.structures.filter((s) => s.kind === kind);
  }

  hasStructureNear(x, y, kind, radius = 5) {
    for (const s of this.structures) {
      if (s.kind !== kind) continue;
      if (Math.hypot(s.x - x, s.y - y) <= radius) return true;
    }
    return false;
  }

  addStructure(s) {
    s.x |= 0;
    s.y |= 0;
    if (!s.stock) s.stock = new Map();
    if (!s.occupants) s.occupants = [];
    if (s.condition == null) s.condition = 1;
    this.structures.push(s);
    return s;
  }

  removeStructure(s) {
    const i = this.structures.indexOf(s);
    if (i >= 0) this.structures.splice(i, 1);
  }

  /** Slow wear; hearths/fields need care from agents elsewhere. */
  decayStructures() {
    for (const s of this.structures) {
      if (s.kind === 'bridge') {
        s.condition = clamp((s.condition ?? 1) - 0.00015);
      } else if (s.kind === 'path') {
        s.condition = clamp((s.condition ?? 1) - 0.0004);
      } else {
        s.condition = clamp((s.condition ?? 1) - 0.00008);
      }
      if (s.condition < 0.05) {
        this.removeStructure(s);
      }
    }
  }

  // ── Walkability & bridges ─────────────────────────────────────

  walkable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const st = this.structureAt(x, y);
    if (st?.kind === 'bridge' && (st.condition ?? 1) > 0.1) return true;
    if (st?.kind === 'path') return true;
    const t = this.at(x, y);
    return t > TERRAIN.MARSH;
  }

  hasBridgeAccess(x, y) {
    const st = this.structureAt(x, y);
    return st?.kind === 'bridge' && (st.condition ?? 1) > 0.1;
  }

  moveCost(x, y) {
    if (!this.inBounds(x, y)) return 99;
    const st = this.structureAt(x, y);
    if (st?.kind === 'bridge') return 1.05;
    if (st?.kind === 'path') return 0.75;
    const t = this.at(x, y);
    if (t <= TERRAIN.MARSH) return 99;
    if (t === TERRAIN.ROCK || t === TERRAIN.HILL) return 1.6;
    if (t === TERRAIN.FOREST) return 1.35;
    if (t === TERRAIN.SAND) return 1.25;
    const trail = this.trails[this.idx(x, y)] || 0;
    return Math.max(0.55, 1 - trail * 0.35);
  }

  landAdjacent(x, y) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!this.inBounds(nx, ny)) continue;
      if (this.at(nx, ny) > TERRAIN.MARSH) return true;
    }
    return false;
  }

  bridgeAdjacent(x, y) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const st = this.structureAt(x + dx, y + dy);
      if (st?.kind === 'bridge') return st;
    }
    return null;
  }

  findBridgeWorkSites(cx, cy, radius = 24, limit = 16) {
    const out = [];
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(this.h - 1, cy + radius);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(this.w - 1, cx + radius);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.at(x, y);
        if (t !== TERRAIN.WATER && t !== TERRAIN.MARSH) continue;
        if (this.structureAt(x, y)) continue;

        const onLand = this.landAdjacent(x, y);
        const onBridge = this.bridgeAdjacent(x, y);
        if (!onLand && !onBridge) continue;

        const distC = Math.hypot(x - cx, y - cy);
        let score = 1 / (1 + distC * 0.08);
        if (onBridge) score += 1.4;
        if (onLand && !onBridge) score += 0.55;

        let waterN = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const tt = this.at(x + dx, y + dy);
          if (tt === TERRAIN.WATER || tt === TERRAIN.MARSH) waterN++;
        }
        score += (4 - waterN) * 0.08;

        out.push({
          x, y, score,
          extends: !!onBridge,
          starts: onLand && !onBridge,
          spanId: onBridge?.spanId || null,
        });
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  bridgeCrosses(cx, cy, radius = 28, minDist = 3) {
    const bridges = this.structuresOfKind('bridge').filter(
      (b) => Math.hypot(b.x - cx, b.y - cy) <= radius && (b.condition ?? 1) > 0.1,
    );
    if (bridges.length < 2) return false;

    const key = (x, y) => `${x},${y}`;
    const bridgeSet = new Set(bridges.map((b) => key(b.x, b.y)));
    const visited = new Set();

    for (const start of bridges) {
      const sk = key(start.x, start.y);
      if (visited.has(sk)) continue;
      const q = [[start.x, start.y]];
      visited.add(sk);
      const lands = [];
      while (q.length) {
        const [x, y] = q.shift();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nk = key(nx, ny);
          if (bridgeSet.has(nk) && !visited.has(nk)) {
            visited.add(nk);
            q.push([nx, ny]);
          } else if (this.at(nx, ny) > TERRAIN.MARSH) {
            lands.push({ x: nx, y: ny });
          }
        }
      }
      for (let i = 0; i < lands.length; i++) {
        for (let j = i + 1; j < lands.length; j++) {
          if (Math.hypot(lands[i].x - lands[j].x, lands[i].y - lands[j].y) >= minDist) {
            return true;
          }
        }
      }
    }
    return false;
  }

  bridgeSpanCount(cx, cy, radius = 18) {
    const bridges = this.structuresOfKind('bridge').filter(
      (b) => Math.hypot(b.x - cx, b.y - cy) <= radius,
    );
    const ids = new Set();
    for (const b of bridges) ids.add(b.spanId || `${b.x},${b.y}`);
    return ids.size;
  }

  waterNearCount(cx, cy, radius = 14) {
    let n = 0;
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(this.h - 1, cy + radius);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(this.w - 1, cx + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.at(x, y);
        if (t === TERRAIN.WATER || t === TERRAIN.MARSH) n++;
      }
    }
    return n;
  }

  nearestWater(x, y, radius = 20) {
    let best = null;
    let bd = Infinity;
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(this.h - 1, y + radius);
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(this.w - 1, x + radius);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const t = this.at(xx, yy);
        if (t !== TERRAIN.WATER && t !== TERRAIN.MARSH) continue;
        const d = (xx - x) ** 2 + (yy - y) ** 2;
        if (d < bd) {
          bd = d;
          best = { x: xx, y: yy };
        }
      }
    }
    return best;
  }

  // ── Terraforming ──────────────────────────────────────────────

  /**
   * Change terrain under constraints. Returns true if applied.
   * mode: 'fill' (raise out of water), 'dig' (lower toward water),
   *       'clear' (forest → grass), 'enrich' (boost fertility).
   */
  terraform(x, y, mode, agentName = null) {
    if (!this.inBounds(x, y)) return false;
    if (this.structureAt(x, y)) return false;
    const i = this.idx(x, y);
    const t = this.terrain[i];
    let changed = false;

    if (mode === 'fill') {
      if (t === TERRAIN.WATER || t === TERRAIN.MARSH || t === TERRAIN.DEEP) {
        this.terrain[i] = TERRAIN.GRASS;
        this.elev[i] = Math.max(this.elev[i], 0.4);
        this.moist[i] *= 0.7;
        changed = true;
      }
    } else if (mode === 'dig') {
      if (t > TERRAIN.MARSH && t < TERRAIN.ROCK) {
        this.terrain[i] = TERRAIN.MARSH;
        this.elev[i] = Math.min(this.elev[i], 0.34);
        this.moist[i] = Math.max(this.moist[i], 0.7);
        changed = true;
      }
    } else if (mode === 'clear') {
      if (t === TERRAIN.FOREST) {
        this.terrain[i] = TERRAIN.GRASS;
        changed = true;
      }
    } else if (mode === 'enrich') {
      this.fertility[i] = clamp(this.fertility[i] + 0.08);
      changed = true;
    }

    if (changed) {
      this.refreshBedAt(x, y);
      this.terraformLog.push({
        tick: this.tick, x, y, mode, by: agentName, from: t, to: this.terrain[i],
      });
      if (this.terraformLog.length > 200) this.terraformLog.shift();
    }
    return changed;
  }

  refreshBedAt(x, y) {
    const i = this.idx(x, y);
    this.beds.delete(i);
    const table = YIELDS[this.at(x, y)];
    if (!table) return;
    const bed = {};
    for (const [res, rate] of Object.entries(table)) {
      if (res === 'game') continue;
      const max = 4 + rate * 10;
      bed[res] = {
        amount: max * 0.5,
        max,
        regrow: 0.002 + rate * 0.006,
      };
    }
    if (Object.keys(bed).length) this.beds.set(i, bed);
    this.syncGameBed(x, y);
  }

  // ── Resources ─────────────────────────────────────────────────

  bedAt(x, y) {
    return this.beds.get(this.idx(x, y)) || null;
  }

  findResource(key, agent, radius = 16) {
    let best = null;
    let bestScore = -1;
    const y0 = Math.max(0, agent.y - radius);
    const y1 = Math.min(this.h - 1, agent.y + radius);
    const x0 = Math.max(0, agent.x - radius);
    const x1 = Math.min(this.w - 1, agent.x + radius);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const bed = this.bedAt(x, y);
        if (!bed?.[key] || bed[key].amount < 0.5) continue;

        let approachOk = this.walkable(x, y);
        if (!approachOk) {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (this.walkable(x + dx, y + dy)) {
              approachOk = true;
              break;
            }
          }
        }
        if (!approachOk && key !== 'water' && key !== 'fish') continue;

        const d = Math.hypot(x - agent.x, y - agent.y) + 0.1;
        const score = bed[key].amount / d;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  harvest(x, y, key, amount) {
    const bed = this.bedAt(x, y);
    if (!bed?.[key]) return 0;
    const take = Math.min(amount, bed[key].amount);
    bed[key].amount = Math.max(0, bed[key].amount - take);

    // Hunting removes fauna when game is taken
    if (key === 'game' && take > 0) {
      const prey = this.fauna.find(
        (f) => f.x === (x | 0) && f.y === (y | 0) && f.kind !== 'fish',
      );
      if (prey) this.removeFauna(prey);
    }
    if (key === 'fish' && take > 0) {
      const prey = this.fauna.find(
        (f) => f.x === (x | 0) && f.y === (y | 0) && f.kind === 'fish',
      );
      if (prey) this.removeFauna(prey);
    }
    return take;
  }

  // ── Time ──────────────────────────────────────────────────────

  step(dt = 1) {
    this.tick += dt;
    const dayOfYear = this.tick % (24 * 30);
    const s = Math.floor((dayOfYear / 60) * 4) % 4;
    this.season = SEASONS[s];
    const seasonal = [0.6, 0.9, 0.55, 0.15][s];
    const hour = this.tick % 24;
    const diurnal = 0.5 - Math.cos((hour / 24) * Math.PI * 2) * 0.5;
    this.temperature = clamp(seasonal * 0.75 + diurnal * 0.25);
    this.isNight = hour < 6 || hour >= 20;

    if (this.tick % 6 === 0) {
      const roll = this.rng.next();
      this.weather =
        roll < 0.06 ? 'storm' :
        roll < 0.24 ? 'rain' :
        roll < 0.34 ? 'overcast' : 'clear';
    }

    const growth =
      (this.weather === 'rain' ? 1.5 : this.weather === 'storm' ? 1.2 : 1) *
      (0.35 + seasonal);

    const keys = [...this.beds.keys()];
    const sampleCount = Math.max(1, Math.floor(keys.length / 6));
    for (let n = 0; n < sampleCount; n++) {
      const i = keys[(this.tick * 7 + n * 6) % keys.length];
      const bed = this.beds.get(i);
      if (!bed) continue;
      for (const r of Object.values(bed)) {
        r.amount = Math.min(r.max, r.amount + r.regrow * growth * 6 * dt);
      }
    }

    for (let i = 0; i < this.trails.length; i += 3) {
      const j = (i + this.tick) % this.trails.length;
      this.trails[j] *= 0.9995;
      this.danger[j] *= 0.998;
    }

    if (this.tick % 4 === 0) this.stepFauna();
    if (this.tick % 24 === 0) this.decayStructures();
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

  /** Snapshot for UI / map layers */
  faunaSummary() {
    const by = {};
    for (const f of this.fauna) by[f.kind] = (by[f.kind] || 0) + 1;
    return { total: this.fauna.length, byKind: by, list: this.fauna.slice(0, 80) };
  }
}

export { YIELDS, FAUNA_KINDS };
