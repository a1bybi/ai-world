// sim.js — Part 1/2 (bootstrap → river → build → social core)
// Society: settlements, archive, food crisis, birth lock, norms→law,
// projects, real structures (bridge lengths, walls, arenas, …).

import { RNG } from '../core/rng.js';
import { Language } from '../core/language.js';
import { World, TERRAIN } from '../world/world.js';
import { Ontology } from './concepts.js';
import { Chronicle } from './chronicle.js';
import { Agent, YEAR_TICKS, SKILLS } from './agent.js';
import { randomGenome, inherit } from './genome.js';
import { think } from './mind.js';
import { appraise, dominantEmotion, moodWord } from './emotion.js';
import { clamp, dist, mean, topN, gini, sum } from '../core/util.js';
import { STRUCTURE_KINDS } from './actions.js';

const BALANCE = {
  foodPerPersonDay: 1.15,
  birthFoodDaysMin: 5,
  birthDependencyMax: 1.2,
  archiveMinConfidence: 0.4,
  campHolders: 2,
  bridgeProjectWood: 8,
  fieldProjectLabor: 6,
  storeProjectLabor: 5,
  wallProjectLabor: 8,
  spoilRate: 0.002,
  orphanRadius: 14,
  founderGrain: 28,
  maxBridgeSpansNear: 4,
};

const NORM_LABELS = {
  theft: 'what is not given must not be taken',
  violence: 'hands are not raised against our own',
  sharing: 'the hungry are fed from what we have',
  burial: 'the dead are put into the ground with words',
  teaching: 'what one knows, all may learn',
  craft: 'a thing well made is owed respect',
  neglect: 'the hungry are not left to watch the fed',
  rescue: 'the hurt are not left alone',
  gift: 'what is given freely binds us',
  law: 'what is spoken as law is kept',
};

function emptySettlementStats() {
  return {
    people: 0,
    children: 0,
    adults: 0,
    foodStock: 0,
    foodDays: 0,
    avgHunger: 0,
    dependency: 0,
    bridgeCrosses: false,
    structures: 0,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class Simulation {
  constructor(seed = 'aurorae', opts = {}) {
    this.seed = String(seed);
    this.rng = new RNG(this.seed);
    this.lang = new Language(this.rng);
    this.world = new World(this.rng, opts);
    this.ont = new Ontology(this.rng, this.lang);
    this.chronicle = new Chronicle(this);

    this.agents = [];
    this.living = [];
    this.dead = [];
    this.settlements = [];
    this.origin = null;
    this.generation = 1;
    this.tick = 0;
    this.logBuffer = [];
    this.eventLog = [];
    this.counters = {
      gifts: 0,
      thefts: 0,
      fights: 0,
      lessons: 0,
      births: 0,
      deaths: 0,
      inventions: 0,
      trades: 0,
      burials: 0,
      rituals: 0,
      builds: 0,
    };
    this.marketPrices = new Map();
    this.lostKnowledge = [];
    this.campKnowledge = new Map();
    this.archive = new Set();
    this.laws = new Map();
    this.normTally = new Map();
    this.ritualPull = 0;
    this.nextStructureId = 1;
    this.nextSpanId = 1;
    this.nextAgentId = 1;
    this.era = { name: 'the First Waking', started: 0, capability: 0 };
    this._lastReportTick = 0;

    this.seedPopulation(opts.founders || 14);
    this.refreshAllMarkets();
  }

  // ── Bootstrap ─────────────────────────────────────────────────

  seedPopulation(n = 14) {
    const cx = Math.floor(this.world.w / 2);
    const cy = Math.floor(this.world.h / 2);
    let site = null;
    for (let r = 0; r < 28 && !site; r++) {
      for (let t = 0; t < 32; t++) {
        const x = clamp(
          cx + Math.round(Math.cos((t / 32) * Math.PI * 2) * r),
          2,
          this.world.w - 3,
        );
        const y = clamp(
          cy + Math.round(Math.sin((t / 32) * Math.PI * 2) * r),
          2,
          this.world.h - 3,
        );
        if (this.world.walkable(x, y) && this.world.at(x, y) > TERRAIN.MARSH) {
          site = { x, y };
          break;
        }
      }
    }
    if (!site) site = { x: cx, y: cy };

    const name = this.lang.placeName?.() || 'Kei-ve';
    this.origin = this.ensureSettlementMeta({
      id: 's0',
      name,
      x: site.x,
      y: site.y,
      founded: 0,
      founderId: null,
      projects: [],
      stats: emptySettlementStats(),
      championId: null,
      tier: 1,
      archive: new Set(),
    });
    this.settlements.push(this.origin);

    for (let i = 0; i < n; i++) {
      const g = randomGenome(this.rng);
      const a = new Agent(this, {
        id: `a${this.nextAgentId++}`,
        genome: g,
        x: clamp(site.x + this.rng.int(-2, 2), 1, this.world.w - 2),
        y: clamp(site.y + this.rng.int(-2, 2), 1, this.world.h - 2),
        ageYears: this.rng.float(16, 36),
      });
      a.add('grain', this.rng.float(5, 12));
      a.add('meat', this.rng.float(1, 4));
      a.add('wood', this.rng.float(4, 10));
      a.add('water', this.rng.float(2, 6));
      a.add('fibre', this.rng.float(1, 4));
      a.add('stone', this.rng.float(0, 2));
      this.agents.push(a);
      this.living.push(a);
    }
    this.origin.founderId = this.living[0]?.id;

    const s0 = this.living[0];
    if (s0) {
      this.bootstrapStructure(s0, 'store', {
        grain: BALANCE.founderGrain,
        meat: 8,
        water: 12,
      });
      const home = this.bootstrapStructure(s0, 'shelter');
      if (home) s0.home = home;
      this.bootstrapStructure(s0, 'hearth');
    }

    this.record(
      null,
      'era',
      `${name} was spoken into being on the ${this.world.season} ground`,
      { valence: 0.5, intensity: 0.7, landmark: true },
    );
  }

  bootstrapStructure(agent, kind, stockObj = null) {
    const spot = this.pickBuildSite(agent, kind, this.origin);
    if (!spot) return null;
    const st = {
      id: `${kind}_${this.nextStructureId++}`,
      kind,
      x: spot.x,
      y: spot.y,
      word: this.lang.thingName?.(kind) || kind,
      stock: new Map(),
      builtBy: agent.id,
      tick: 0,
      condition: 1,
      occupants: [],
    };
    if (stockObj) {
      for (const [k, v] of Object.entries(stockObj)) st.stock.set(k, v);
    }
    if (kind === 'field') {
      st.ripeness = 0.2;
      st.tended = 0.3;
      st.harvests = 0;
    }
    this.world.addStructure(st);
    return st;
  }

  ensureSettlementMeta(s) {
    if (!s.stats) s.stats = emptySettlementStats();
    if (!s.projects) s.projects = [];
    if (!s.archive) s.archive = new Set();
    return s;
  }

  // ── Lookups ───────────────────────────────────────────────────

  byId(id) {
    if (!id) return null;
    return this.agents.find((a) => a.id === id) || null;
  }

  nearestSettlement(x, y) {
    let best = this.origin;
    let bd = Infinity;
    for (const s of this.settlements) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  nearby(a, radius) {
    return this.living.filter(
      (o) => o.id !== a.id && Math.hypot(o.x - a.x, o.y - a.y) <= radius,
    );
  }

  // ── Food, archive, camp knowledge ─────────────────────────────

  totalFood() {
    let t = 0;
    for (const a of this.living) {
      for (const [k, v] of a.inventory) {
        if (this.ont.get(k)?.functions?.sustenance) t += v;
      }
    }
    for (const s of this.world.structuresOfKind('store')) {
      if (!s.stock) continue;
      for (const [k, v] of s.stock) {
        if (this.ont.get(k)?.functions?.sustenance) t += v;
      }
    }
    return t;
  }

  foodCrisisLevel(settlement = null) {
    const s = settlement || this.origin;
    if (!s?.stats) {
      const food = this.totalFood();
      const n = Math.max(1, this.living.length);
      return clamp(1 - food / (n * 8));
    }
    const fd = s.stats.foodDays;
    if (fd < 2) return 1;
    if (fd < 4) return 0.85;
    if (fd < 6) return 0.55;
    if (fd < 9) return 0.3;
    return 0;
  }

  archiveKnowledge(key) {
    if (!key) return;
    this.archive.add(key);
    for (const s of this.settlements) s.archive?.add(key);
  }

  isArchived(key) {
    return this.archive.has(key);
  }

  updateCampKnowledge() {
    this.campKnowledge.clear();
    for (const a of this.living) {
      for (const k of a.memory.knownKeys('recipe')) {
        if (!this.campKnowledge.has(k)) this.campKnowledge.set(k, new Set());
        this.campKnowledge.get(k).add(a.id);
      }
    }
    for (const [k, holders] of this.campKnowledge) {
      if (holders.size >= BALANCE.campHolders) this.archiveKnowledge(k);
    }
  }

  isCampKnowledge(key) {
    if (this.isArchived(key)) return true;
    const h = this.campKnowledge.get(key);
    return !!(h && h.size >= BALANCE.campHolders);
  }

  tryLearnFromArchive(a) {
    if (!this.archive.size || this.rng.bool(0.65)) return;
    const nearHall =
      this.world.hasStructureNear?.(a.x, a.y, 'store', 6) ||
      this.world.hasStructureNear?.(a.x, a.y, 'workshop', 6) ||
      this.world.hasStructureNear?.(a.x, a.y, 'hall', 8);
    if (!nearHall) return;
    for (const key of this.archive) {
      if (a.memory.knows(key, 0.35)) continue;
      if (!this.ont.get(key)) continue;
      a.memory.learn(key, {
        kind: 'recipe',
        confidence: 0.32 * (a.genome.learning || 0.5),
        valence: 0.25,
        source: 'archive',
      });
      break;
    }
  }

  // ── Settlement stats & projects ───────────────────────────────

  refreshSettlementStats(s) {
    this.ensureSettlementMeta(s);
    const near = this.living.filter((a) => Math.hypot(a.x - s.x, a.y - s.y) < 22);
    let food = 0;
    let hunger = 0;
    let children = 0;
    for (const a of near) {
      hunger += a.body.hunger;
      if (a.isChild?.(this.world.tick) || a.ageAt(this.world.tick) < 12) children++;
      for (const [k, v] of a.inventory) {
        if (this.ont.get(k)?.functions?.sustenance) food += v;
      }
    }
    for (const st of this.world.structures) {
      if (Math.hypot(st.x - s.x, st.y - s.y) > 20) continue;
      if (st.kind === 'store' && st.stock) {
        for (const [k, v] of st.stock) {
          if (this.ont.get(k)?.functions?.sustenance) food += v;
        }
      }
    }
    const people = Math.max(1, near.length);
    const adults = Math.max(0, near.length - children);
    s.stats.people = near.length;
    s.stats.children = children;
    s.stats.adults = adults;
    s.stats.foodStock = food;
    s.stats.foodDays = food / Math.max(1, people * BALANCE.foodPerPersonDay);
    s.stats.avgHunger = near.length ? hunger / near.length : 0;
    s.stats.dependency = children / Math.max(1, adults);
    s.stats.bridgeCrosses = !!this.world.bridgeCrosses?.(s.x, s.y, 28);
    s.stats.structures = this.world.structures.filter(
      (st) => Math.hypot(st.x - s.x, st.y - s.y) < 18,
    ).length;
    return s.stats;
  }

  settlementNeeds(s) {
    this.ensureSettlementMeta(s);
    this.refreshSettlementStats(s);
    const people = Math.max(1, s.stats.people);
    const near = (kind) =>
      this.world.structuresOfKind(kind).filter(
        (st) => Math.hypot(st.x - s.x, st.y - s.y) < 16,
      ).length;

    const shelters = near('shelter');
    const hearths = near('hearth');
    const stores = near('store');
    const fields = near('field');
    const workshops = near('workshop');
    const wells = near('well');
    const shrines = near('shrine');
    const walls = near('wall');
    const halls = near('hall');
    const plazas = near('plaza');
    const arenas = near('arena');
    const kilns = near('kiln');
    const paths = near('path');
    const bridges = near('bridge');
    const waterNear = this.world.waterNearCount?.(s.x, s.y, 14) || 0;
    const crosses = s.stats.bridgeCrosses;

    const wantShelters = Math.max(1, Math.ceil(people / 2.5));
    const wantFields = Math.max(1, Math.ceil(people / 5));
    const wantStores = Math.max(1, Math.ceil(people / 12));

    return {
      people,
      shelterDeficit: clamp((wantShelters - shelters) / wantShelters),
      hearthDeficit: hearths < 1 ? 0.7 : hearths < Math.ceil(people / 10) ? 0.35 : 0,
      storeDeficit:
        clamp((wantStores - stores) / wantStores) + (s.stats.foodDays < 6 ? 0.25 : 0),
      fieldDeficit:
        clamp((wantFields - fields) / wantFields) +
        (s.stats.foodDays < 8 ? 0.35 : 0) +
        (s.stats.avgHunger > 0.45 ? 0.25 : 0),
      workshopDeficit:
        people > 8 && workshops < 1 ? 0.45 : workshops < Math.ceil(people / 20) ? 0.2 : 0,
      wellDeficit: people > 10 && wells < 1 ? 0.4 : 0,
      shrineDeficit: people > 16 && shrines < 1 ? 0.25 : 0,
      wallDeficit:
        people > 12
          ? clamp((Math.ceil(people / 18) - walls) / Math.max(1, Math.ceil(people / 18)))
          : 0,
      hallDeficit: people > 24 && halls < 1 ? 0.35 : 0,
      plazaDeficit: people > 14 && plazas < 1 ? 0.3 : 0,
      arenaDeficit: people > 22 && arenas < 1 ? 0.28 : 0,
      kilnDeficit: people > 16 && workshops > 0 && kilns < 1 ? 0.3 : 0,
      pathDeficit:
        people > 6
          ? clamp((Math.ceil(people / 10) - paths) / Math.max(1, Math.ceil(people / 10)))
          : 0,
      bridgeDeficit:
        waterNear > 8 && !crosses
          ? clamp(0.55 + waterNear * 0.02 - bridges * 0.08)
          : waterNear > 4 && bridges > 0 && !crosses
            ? 0.75
            : 0,
      foodDays: s.stats.foodDays,
      dependency: s.stats.dependency,
      bridgeCrosses: crosses,
    };
  }

  settlementPressure(s) {
    const n = this.settlementNeeds(s);
    return (
      n.shelterDeficit * 0.2 +
      n.fieldDeficit * 0.25 +
      n.storeDeficit * 0.15 +
      n.bridgeDeficit * 0.2 +
      n.wallDeficit * 0.1 +
      (n.foodDays < 5 ? 0.3 : 0)
    );
  }

  syncProjects(s) {
    this.ensureSettlementMeta(s);
    const n = this.settlementNeeds(s);
    const has = (kind) => s.projects.some((p) => p.kind === kind && !p.done);

    if (n.bridgeDeficit > 0.4 && !n.bridgeCrosses && !has('bridge')) {
      s.projects.push({
        kind: 'bridge',
        label: 'span the water',
        progress: 0,
        target: BALANCE.bridgeProjectWood,
        materialPaid: 0,
        labor: 0,
        done: false,
        championId: s.championId,
      });
    }
    if (n.fieldDeficit > 0.45 && !has('field')) {
      s.projects.push({
        kind: 'field',
        label: 'open more ground',
        progress: 0,
        target: BALANCE.fieldProjectLabor,
        materialPaid: 0,
        labor: 0,
        done: false,
        championId: s.championId,
      });
    }
    if (n.storeDeficit > 0.45 && !has('store')) {
      s.projects.push({
        kind: 'store',
        label: 'raise a store',
        progress: 0,
        target: BALANCE.storeProjectLabor,
        materialPaid: 0,
        labor: 0,
        done: false,
        championId: s.championId,
      });
    }
    if (n.wallDeficit > 0.5 && !has('wall')) {
      s.projects.push({
        kind: 'wall',
        label: 'raise a wall',
        progress: 0,
        target: BALANCE.wallProjectLabor,
        materialPaid: 0,
        labor: 0,
        done: false,
        championId: s.championId,
      });
    }
    if (n.arenaDeficit > 0.5 && !has('arena')) {
      s.projects.push({
        kind: 'arena',
        label: 'mark a gathering ring',
        progress: 0,
        target: 7,
        materialPaid: 0,
        labor: 0,
        done: false,
        championId: s.championId,
      });
    }
  }

  activeProject(s) {
    if (!s) return null;
    this.syncProjects(s);
    return s.projects.find((p) => !p.done) || null;
  }

  projectBias(a, s) {
    if (!s) return 0;
    const p = this.activeProject(s);
    if (!p) return 0;
    let b = 0.35;
    if (p.championId === a.id) b += 0.45;
    if (s.championId === a.id) b += 0.25;
    if (this.foodCrisisLevel(s) > 0.5 && (p.kind === 'field' || p.kind === 'store')) {
      b += 0.4;
    }
    return b;
  }

  contributeProject(a, s, kind, material, amount = 0) {
    if (!s) return;
    this.syncProjects(s);
    const p = s.projects.find((x) => x.kind === kind && !x.done);
    if (!p) return;
    p.labor = (p.labor || 0) + 1;
    p.materialPaid = (p.materialPaid || 0) + amount;
    p.progress = p.labor + p.materialPaid * 0.5;
    if (p.progress >= p.target) {
      p.done = true;
      this.record(
        a,
        'first',
        `${a.name} and the others finished the work: ${p.label}`,
        { valence: 0.6, intensity: 0.6 },
      );
    }
  }

  // ── Path / river ──────────────────────────────────────────────

  landReachable(from, to, maxSteps = 80) {
    const key = (x, y) => `${x},${y}`;
    const q = [[from.x | 0, from.y | 0, 0]];
    const seen = new Set([key(from.x, from.y)]);
    while (q.length) {
      const [x, y, d] = q.shift();
      if (x === (to.x | 0) && y === (to.y | 0)) return true;
      if (d >= maxSteps) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (seen.has(k) || !this.world.inBounds(nx, ny)) continue;
        if (this.world.at(nx, ny) <= TERRAIN.MARSH) continue;
        seen.add(k);
        q.push([nx, ny, d + 1]);
      }
    }
    return false;
  }

  riverBlocks(from, to, maxSteps = 70) {
    const landOnly = (x, y) =>
      this.world.inBounds(x, y) && this.world.at(x, y) > TERRAIN.MARSH;
    const walk = (x, y) => this.world.walkable(x, y);
    const bfs = (pass) => {
      const key = (x, y) => `${x},${y}`;
      const q = [[from.x | 0, from.y | 0, 0]];
      const seen = new Set([key(from.x, from.y)]);
      while (q.length) {
        const [x, y, d] = q.shift();
        if (x === (to.x | 0) && y === (to.y | 0)) return true;
        if (d >= maxSteps) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          const k = key(nx, ny);
          if (seen.has(k) || !pass(nx, ny)) continue;
          seen.add(k);
          q.push([nx, ny, d + 1]);
        }
      }
      return false;
    };
    return !bfs(landOnly) && bfs(walk);
  }

  farBankTarget(a, radius = 22) {
    const home = this.nearestSettlement(a.x, a.y);
    for (let i = 0; i < 40; i++) {
      const x = clamp(home.x + this.rng.int(-radius, radius), 1, this.world.w - 2);
      const y = clamp(home.y + this.rng.int(-radius, radius), 1, this.world.h - 2);
      if (this.world.at(x, y) <= TERRAIN.MARSH) continue;
      if (this.landReachable(home, { x, y })) continue;
      if (this.world.walkable(x, y) || this.riverBlocks(home, { x, y })) {
        return { x, y };
      }
    }
    return null;
  }

  // ── Building ──────────────────────────────────────────────────

  bestBuildMaterial(a, fn) {
    const prefer =
      fn === 'heat' || fn === 'shelter'
        ? ['wood', 'stone', 'clay', 'fibre']
        : fn === 'sustenance'
          ? ['wood', 'fibre', 'stone']
          : ['wood', 'stone', 'clay', 'fibre', 'reed'];
    let best = null;
    for (const k of prefer) {
      const n = a.count(k);
      let storeN = 0;
      for (const s of this.world.structuresOfKind('store')) {
        if (dist(a, s) < 14 && s.stock) storeN += s.stock.get(k) || 0;
      }
      if (n + storeN < 1) continue;
      const score = (n + storeN * 0.5) * (k === 'wood' ? 1.1 : 1);
      if (!best || score > best.score) {
        best = { key: k, score: Math.min(1, score / 8) };
      }
    }
    return best;
  }

  pickBuildSite(a, kind, settlement) {
    const cx = settlement?.x ?? a.x;
    const cy = settlement?.y ?? a.y;

    if (kind === 'bridge') {
      const sites = this.world.findBridgeWorkSites?.(cx, cy, 26, 10) || [];
      return sites[0] ? { x: sites[0].x, y: sites[0].y } : null;
    }

    const startR = kind === 'wall' ? 5 : kind === 'arena' || kind === 'plaza' ? 3 : 2;
    for (let r = startR; r <= 14; r++) {
      const candidates = [];
      for (let t = 0; t < r * 6; t++) {
        const ang = (t / (r * 6)) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const y = Math.round(cy + Math.sin(ang) * r);
        if (!this.world.inBounds(x, y)) continue;
        if (this.world.structureAt(x, y)) continue;

        if (kind === 'field') {
          const t0 = this.world.at(x, y);
          if (t0 !== TERRAIN.MEADOW && t0 !== TERRAIN.GRASS) continue;
        } else if (kind === 'well') {
          if (!this.world.nearestWater?.(x, y, 6)) continue;
          if (!this.world.walkable(x, y)) continue;
        } else if (kind === 'wall') {
          if (!this.world.walkable(x, y)) continue;
        } else if (kind === 'arena' || kind === 'plaza') {
          if (!this.world.walkable(x, y)) continue;
          if (this.world.at(x, y) <= TERRAIN.MARSH) continue;
        } else if (!this.world.walkable(x, y)) {
          continue;
        }

        let score = 1 / (1 + Math.hypot(x - cx, y - cy) * 0.05);
        if (kind === 'field') {
          score += this.world.fertility?.[this.world.idx(x, y)] || 0.5;
        }
        if (kind === 'store' || kind === 'hall') {
          score += 0.2 / (1 + Math.hypot(x - cx, y - cy));
        }
        if (kind === 'wall') score += r * 0.02;
        candidates.push({ x, y, score });
      }
      if (candidates.length) {
        candidates.sort((p, q) => q.score - p.score);
        return { x: candidates[0].x, y: candidates[0].y };
      }
    }
    return null;
  }

  raiseStructure(a, kind, spot, materialKey) {
    if (!spot) return null;
    if (this.world.structureAt(spot.x, spot.y)) return null;

    const word = this.lang.thingName?.(kind) || kind;
    const st = {
      id: `${kind}_${this.nextStructureId++}`,
      kind,
      x: spot.x | 0,
      y: spot.y | 0,
      word,
      material: materialKey,
      builtBy: a?.id || null,
      tick: this.world.tick,
      stock: new Map(),
      condition: 1,
      occupants: [],
    };

    if (kind === 'bridge') {
      const adj = this.world.bridgeAdjacent?.(spot.x, spot.y);
      st.spanId = adj?.spanId || `span_${this.nextSpanId++}`;
      this.world.addStructure(st);
      this.counters.builds++;
      const home = this.nearestSettlement(spot.x, spot.y);
      const crosses = this.world.bridgeCrosses?.(home.x, home.y, 28);
      const lengths = this.world
        .structuresOfKind('bridge')
        .filter((b) => b.spanId === st.spanId).length;
      if (lengths <= 1) {
        this.record(a, 'first', `${a.name} laid the first length of a crossing`, {
          valence: 0.55, intensity: 0.55, landmark: true,
        });
      } else if (crosses) {
        this.record(
          a,
          'first',
          `${a.name} closed the crossing — the water no longer divides them`,
          { valence: 0.85, intensity: 0.9, landmark: true },
        );
      } else {
        this.record(a, 'build', `${a.name} laid another length toward the far bank`, {
          valence: 0.4, intensity: 0.4, quiet: true,
        });
      }
      return st;
    }

    if (kind === 'field') {
      st.ripeness = 0.1;
      st.tended = 0.2;
      st.harvests = 0;
    }
    if (kind === 'arena' || kind === 'plaza') st.gatherings = 0;

    this.world.addStructure(st);
    this.counters.builds++;
    const label = STRUCTURE_KINDS[kind]?.desc || kind;
    this.record(
      a,
      'first',
      `${a?.name || 'They'} raised ${word} — ${label}`,
      { valence: 0.7, intensity: 0.65, landmark: true },
    );
    return st;
  }

  foundSettlement(a, at) {
    const name = this.lang.placeName?.() || `camp-${this.settlements.length}`;
    const s = this.ensureSettlementMeta({
      id: `s${this.settlements.length}`,
      name,
      x: at.x | 0,
      y: at.y | 0,
      founded: this.world.tick,
      founderId: a.id,
      projects: [],
      stats: emptySettlementStats(),
      championId: a.id,
      tier: 1,
      archive: new Set([...this.archive]),
    });
    this.settlements.push(s);
    this.record(a, 'migration', `${a.name} founded ${name} beyond the old ground`, {
      valence: 0.7, intensity: 0.8, landmark: true,
    });
    return s;
  }

  // ── Norms & law ───────────────────────────────────────────────

  personalNorm(a, tag) {
    const b = a.memory.belief?.(`norm:${tag}`);
    if (!b || b.confidence < 0.12) return 0;
    return b.valence * b.confidence;
  }

  effectiveNorm(a, tag) {
    const personal = this.personalNorm(a, tag);
    const law = this.laws.get(tag);
    if (law) {
      return clamp(personal * 0.5 + law.strength * law.polarity * 0.5, -1, 1);
    }
    return personal;
  }

  violateNorm(a, tag, intensity = 0.3) {
    const b = a.memory.belief?.(`norm:${tag}`);
    if (b) {
      a.memory.learn(`norm:${tag}`, {
        kind: 'norm',
        confidence: Math.max(0.1, (b.confidence || 0.2) - intensity * 0.1),
        valence: b.valence,
        source: 'violation',
        payload: b.payload,
      });
    }
    const law = this.laws.get(tag);
    if (law) law.strength = clamp(law.strength - intensity * 0.05);
  }

  upholdNorm(a, tag, intensity = 0.2) {
    const label = NORM_LABELS[tag] || tag;
    a.memory.learn(`norm:${tag}`, {
      kind: 'norm',
      confidence: 0.15 + intensity * 0.2,
      valence: 0.5,
      source: 'experience',
      payload: { situation: tag, polarity: 1, label },
    });
  }

  aggregateNorms() {
    const buckets = new Map();
    for (const a of this.living) {
      if (!a.memory?.semantic) continue;
      for (const [key, b] of a.memory.semantic) {
        if (b.kind !== 'norm' || b.confidence < 0.15) continue;
        const sit = b.payload?.situation || String(key).replace(/^norm:/, '');
        const cur = buckets.get(sit) || { n: 0, v: 0, conf: 0 };
        cur.n++;
        cur.v += b.valence;
        cur.conf += b.confidence;
        buckets.set(sit, cur);
      }
    }
    for (const [sit, c] of buckets) {
      if (c.n < Math.max(3, Math.ceil(this.living.length * 0.22))) continue;
      const avgV = c.v / c.n;
      const strength = clamp(c.conf / c.n);
      const polarity = avgV < 0 ? -1 : 1;
      const existing = this.laws.get(sit);
      if (!existing && strength > 0.35) {
        this.laws.set(sit, {
          label: NORM_LABELS[sit] || sit,
          strength,
          polarity,
          since: this.world.tick,
        });
        this.record(
          null,
          'law',
          `It became a rule among them: ${NORM_LABELS[sit] || sit}`,
          { valence: polarity * 0.4, intensity: 0.7, landmark: true },
        );
      } else if (existing) {
        existing.strength = lerp(existing.strength, strength, 0.15);
        if (existing.strength < 0.18) {
          this.laws.delete(sit);
          this.record(null, 'law', `The rule slipped away: ${existing.label}`, {
            valence: -0.2,
            intensity: 0.45,
          });
        }
      }
    }
  }

  // ── Market ────────────────────────────────────────────────────

  refreshAllMarkets() {
    const counts = new Map();
    for (const a of this.living) {
      for (const [k, v] of a.inventory) {
        counts.set(k, (counts.get(k) || 0) + v);
      }
    }
    for (const s of this.world.structuresOfKind('store')) {
      if (!s.stock) continue;
      for (const [k, v] of s.stock) {
        counts.set(k, (counts.get(k) || 0) + v);
      }
    }
    for (const [k, n] of counts) {
      const scarcity = 1 / (1 + n);
      const prev = this.marketPrices.get(k)?.price || 1;
      this.marketPrices.set(k, {
        price: clamp(lerp(prev, 0.5 + scarcity * 4, 0.2), 0.2, 12),
        stock: n,
      });
    }
  }

  priceOf(key) {
    return this.marketPrices.get(key)?.price ?? 1;
  }

  // ── Capability / gloss ────────────────────────────────────────

  capabilityGaps(a) {
    const need = [
      'sustenance', 'shelter', 'heat', 'cutting', 'storage',
      'medicine', 'cordage', 'clothing', 'vessel',
    ];
    const gaps = [];
    for (const fn of need) {
      let best = 0;
      for (const k of a.inventory.keys()) {
        best = Math.max(best, this.ont.get(k)?.serves?.(fn) || 0);
      }
      for (const k of a.memory.knownKeys('recipe')) {
        best = Math.max(best, this.ont.get(k)?.serves?.(fn) || 0);
      }
      if (best < 0.35) gaps.push(fn);
    }
    return gaps;
  }

  glossConcept(key) {
    const c = this.ont.get(key);
    if (!c) return key;
    const fn = c.bestFn || Object.keys(c.functions || {})[0] || '';
    return fn ? `${c.word} (${fn})` : c.word;
  }

  respectFor(a, o) {
    const r = a.rel(o);
    return (
      (o.reputation || 0.5) * 0.5 +
      (r.trust || 0) * 0.25 +
      (r.affection || 0) * 0.15 +
      (r.kin || 0) * 0.1
    );
  }

  // ── Social ────────────────────────────────────────────────────

  converse(a, o) {
    a.adjustRel(o, { familiarity: 0.08, affection: 0.03 });
    o.adjustRel(a, { familiarity: 0.08, affection: 0.03 });
    const keys = a.memory.knownKeys('recipe').slice(0, 12);
    if (keys.length && this.rng.bool(0.35)) {
      const k = this.rng.pick(keys);
      if (!o.memory.knows(k, 0.2)) {
        o.memory.learn(k, {
          kind: 'recipe',
          confidence: 0.22 * (o.genome.learning || 0.5),
          valence: 0.2,
          source: `told by ${a.name}`,
        });
      }
    }
    // Structure purpose gossip
    if (this.rng.bool(0.2)) {
      for (const kind of ['field', 'store', 'bridge', 'shelter', 'wall', 'arena']) {
        const b = a.memory.belief?.(`structure:${kind}`);
        if (b && b.confidence > 0.25 && !o.memory.knows(`structure:${kind}`, 0.2)) {
          o.memory.learn(`structure:${kind}`, {
            kind: 'lesson',
            confidence: b.confidence * 0.4 * (o.genome.learning || 0.5),
            valence: b.valence,
            source: `told by ${a.name}`,
            payload: b.payload,
          });
          break;
        }
      }
    }
    a.stats.talks = (a.stats.talks || 0) + 1;
  }

  teach(a, o, key) {
    const c = this.ont.get(key);
    if (String(key).startsWith('structure:')) {
      const b = a.memory.belief(key);
      if (b) {
        o.memory.learn(key, {
          kind: 'lesson',
          confidence: Math.min(
            0.7,
            (b.confidence || 0.4) * 0.55 * (o.genome.learning || 0.5),
          ),
          valence: b.valence ?? 0.4,
          source: `taught by ${a.name}`,
          payload: b.payload,
        });
      }
    } else if (c) {
      o.memory.learn(key, {
        kind: 'recipe',
        confidence: 0.55 * (o.genome.learning || 0.5),
        valence: 0.4,
        source: `taught by ${a.name}`,
      });
      this.archiveKnowledge(key);
    } else {
      return;
    }
    a.stats.taught = (a.stats.taught || 0) + 1;
    o.stats.learned = (o.stats.learned || 0) + 1;
    this.counters.lessons++;
    this.upholdNorm(a, 'teaching', 0.15);
    const word = c?.word || String(key).replace('structure:', '');
    this.record(a, 'teach', `${a.name} taught ${o.name} about ${word}`, {
      valence: 0.5,
      intensity: 0.45,
      actors: [a.id, o.id],
      concept: key,
    });
  }

  findDeal(a, o) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 2) continue;
      const desireO = o.desireFor?.(k, this.ont, this) ?? 0;
      if (desireO < 0.3) continue;
      for (const [j, w] of o.inventory) {
        if (w < 1) continue;
        const desireA = a.desireFor?.(j, this.ont, this) ?? 0;
        if (desireA < 0.25) continue;
        const gain = desireA + desireO;
        if (!best || gain > best.gain) {
          best = { give: k, take: j, giveN: 1, takeN: 1, gain };
        }
      }
    }
    return best;
  }

  settleTrade(a, o, deal) {
    if (!deal) return;
    if (a.count(deal.give) < deal.giveN || o.count(deal.take) < deal.takeN) return;
    a.take(deal.give, deal.giveN);
    o.take(deal.take, deal.takeN);
    a.add(deal.take, deal.takeN);
    o.add(deal.give, deal.giveN);
    a.adjustRel(o, { trust: 0.06, familiarity: 0.05 });
    o.adjustRel(a, { trust: 0.06, familiarity: 0.05 });
    a.rel(o).lastTrade = this.world.tick;
    o.rel(a).lastTrade = this.world.tick;
    a.stats.trades = (a.stats.trades || 0) + 1;
    this.counters.trades++;
    this.record(a, 'trade', `${a.name} traded with ${o.name}`, {
      valence: 0.3,
      intensity: 0.25,
      actors: [a.id, o.id],
      quiet: true,
    });
  }

  onTheft(a, o, key, n) {
    this.counters.thefts++;
    a.adjustRel(o, { affection: -0.25, trust: -0.3 });
    o.adjustRel(a, { affection: -0.35, trust: -0.4, conflicts: 1 });
    this.violateNorm(a, 'theft', 0.4);
    this.record(
      a,
      'theft',
      `${a.name} took ${this.ont.get(key)?.word || key} from ${o.name}`,
      { valence: -0.7, intensity: 0.7, actors: [a.id, o.id] },
    );
    appraise(o, {
      goalCongruence: -0.7,
      agency: 'other',
      intensity: 0.7,
      kind: 'theft',
      social: a.id,
      norm: -1,
    });
  }

  resolveFight(a, o) {
    this.counters.fights++;
    a.lastFightTick = this.world.tick;
    o.lastFightTick = this.world.tick;
    const ap = a.body.energy * (0.5 + (a.genome.aggression || 0.3));
    const op = o.body.energy * (0.5 + (o.genome.aggression || 0.3));
    const aWin = this.rng.next() < ap / (ap + op + 0.01);
    const loser = aWin ? o : a;
    const winner = aWin ? a : o;
    loser.body.injury = clamp(loser.body.injury + this.rng.float(0.1, 0.35), 0, 1);
    winner.body.energy = clamp(winner.body.energy - 0.15, 0, 1);
    a.adjustRel(o, { affection: -0.2, conflicts: 1 });
    o.adjustRel(a, { affection: -0.2, conflicts: 1 });
    this.violateNorm(winner, 'violence', 0.35);
    this.record(winner, 'violence', `${winner.name} struck ${loser.name}`, {
      valence: -0.6,
      intensity: 0.75,
      actors: [a.id, o.id],
    });
  }

  tryBond(a, o) {
    if (a.partner || o.partner) return false;
    const ar = a.rel(o);
    const or_ = o.rel(a);
    if (ar.affection < 0.35 || or_.affection < 0.3) return false;
    a.partner = o.id;
    o.partner = a.id;
    a.adjustRel(o, { affection: 0.3, trust: 0.2 });
    o.adjustRel(a, { affection: 0.3, trust: 0.2 });
    this.record(a, 'bond', `${a.name} and ${o.name} bound themselves to one another`, {
      valence: 0.8,
      intensity: 0.85,
      actors: [a.id, o.id],
      landmark: true,
    });
    return true;
  }

  bury(a, corpse) {
    const idx = this.world.corpses.indexOf(corpse);
    if (idx >= 0) this.world.corpses.splice(idx, 1);
    let graves = this.world.sites.find((s) => s.kind === 'graves');
    if (!graves) {
      graves = {
        kind: 'graves',
        x: corpse.x,
        y: corpse.y,
        word: 'the grave field',
      };
      this.world.sites.push(graves);
    }
    this.counters.burials++;
    this.upholdNorm(a, 'burial', 0.25);
    this.record(a, 'burial', `${a.name} put ${corpse.name} into the ground with words`, {
      valence: -0.2,
      intensity: 0.5,
      actors: [a.id, corpse.id],
    });
  }

  performRitual(a, site) {
    a.affect.e.grief = clamp(a.affect.e.grief - 0.15, 0, 1);
    a.affect.e.awe = clamp(a.affect.e.awe + 0.1, 0, 1);
    this.ritualPull = clamp(this.ritualPull + 0.05, 0, 1);
    if (site) site.gatherings = (site.gatherings || 0) + 1;
    this.counters.rituals++;
    this.record(
      a,
      'ritual',
      `${a.name} stood at the ${site?.word || 'place'} and spoke`,
      { valence: 0.3, intensity: 0.4, quiet: true },
    );
  }

  makeArt(a, mediumKey) {
    const word = this.lang.thingName?.('art') || 'a making';
    a.stats.art = (a.stats.art || 0) + 1;
    this.record(
      a,
      'art',
      `${a.name} made ${word}${mediumKey ? ` from ${this.ont.get(mediumKey)?.word}` : ''}`,
      { valence: 0.4, intensity: 0.35, quiet: true },
    );
  }

  onInvention(a, record, concept) {
    this.counters.inventions++;
    this.archiveKnowledge(concept.key);
    const advance = record?.advance;
    this.record(
      a,
      'invention',
      advance
        ? `${a.name} made ${concept.word} — nothing they had served ${concept.bestFn} so well`
        : `${a.name} made ${concept.word}, a ${concept.bestFn} of sorts`,
      {
        valence: advance ? 0.8 : 0.4,
        intensity: advance ? 0.85 : 0.4,
        concept: concept.key,
        landmark: !!advance,
      },
    );
  }

  reputationDelta(a, d) {
    a.reputation = clamp((a.reputation || 0.5) + d, 0, 1);
  }

  // ── Orphans ───────────────────────────────────────────────────

  assignOrphans() {
    for (const child of this.living) {
      const age = child.ageAt(this.world.tick);
      if (age >= 12) continue;
      const mother = this.byId(child.motherId);
      const father = this.byId(child.fatherId);
      if (mother?.alive || father?.alive) continue;
      if (child.caretakerId && this.byId(child.caretakerId)?.alive) continue;
      const adults = this.living
        .filter(
          (a) =>
            a.id !== child.id &&
            a.ageAt(this.world.tick) >= 14 &&
            Math.hypot(a.x - child.x, a.y - child.y) < BALANCE.orphanRadius,
        )
        .sort(
          (x, y) =>
            (y.genome.empathy || 0) + (y.rel(child).affection || 0) -
            ((x.genome.empathy || 0) + (x.rel(child).affection || 0)),
        );
      if (adults[0]) {
        child.caretakerId = adults[0].id;
        adults[0].adjustRel(child, { kin: 0.2, affection: 0.1 });
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  conceptionChance(a, o) {
    const s = this.nearestSettlement(a.x, a.y);
    this.refreshSettlementStats(s);
    if (s.stats.foodDays < BALANCE.birthFoodDaysMin) return 0;
    if (s.stats.dependency > BALANCE.birthDependencyMax) return 0;
    if (this.foodCrisisLevel(s) > 0.55) return 0;
    const ageA = a.ageAt(this.world.tick);
    const ageO = o.ageAt(this.world.tick);
    if (ageA < 16 || ageO < 16 || ageA > 48 || ageO > 48) return 0;
    return (
      0.018 *
      ((a.genome.fertility || 0.5) + (o.genome.fertility || 0.5)) *
      (0.5 + (a.rel(o).affection || 0)) *
      (s.stats.foodDays > 10 ? 1.35 : 1)
    );
  }

  tryConceive() {
    const seen = new Set();
    for (const a of this.living) {
      if (!a.partner || a.pregnant) continue;
      const o = this.byId(a.partner);
      if (!o?.alive || o.pregnant) continue;
      const pairKey = [a.id, o.id].sort().join(':');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      if (this.rng.next() < this.conceptionChance(a, o)) {
        let mother = a;
        if (a.genome.sex === 'f') mother = a;
        else if (o.genome.sex === 'f') mother = o;
        else mother = this.rng.bool() ? a : o;
        mother.pregnant = 1;
        mother.pregnantWith = mother.id === a.id ? o.id : a.id;
      }
    }
  }

  birth(mother) {
    const father = this.byId(mother.pregnantWith);
    const genome = inherit(this.rng, mother.genome, father?.genome || mother.genome);
    const child = new Agent(this, {
      id: `a${this.nextAgentId++}`,
      genome,
      x: mother.x,
      y: mother.y,
      ageYears: 0,
      motherId: mother.id,
      fatherId: father?.id || null,
    });
    mother.pregnant = 0;
    mother.pregnantWith = null;
    mother.children = mother.children || [];
    mother.children.push(child.id);
    if (father) {
      father.children = father.children || [];
      father.children.push(child.id);
    }
    child.household = mother.household || mother.id;
    this.agents.push(child);
    this.living.push(child);
    this.counters.births++;
    for (const [k, v] of [...mother.inventory]) {
      if (this.ont.get(k)?.functions?.sustenance && v > 1) {
        const give = Math.min(2, v - 1);
        mother.take(k, give);
        child.add(k, give);
      }
    }
    this.record(
      mother,
      'birth',
      `${child.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''}`,
      {
        valence: 0.85,
        intensity: 0.9,
        actors: [mother.id, child.id],
        landmark: true,
      },
    );
    return child;
  }

  handOffKnowledge(dying) {
    const recipes = dying.memory.knownKeys('recipe');
    const near = this.living
      .filter(
        (a) => a.id !== dying.id && Math.hypot(a.x - dying.x, a.y - dying.y) < 18,
      )
      .sort((x, y) => dist(dying, x) - dist(dying, y));

    for (const key of recipes) {
      if (this.isCampKnowledge(key) || this.isArchived(key)) continue;
      const heir = near.find((a) => !a.memory.knows(key, 0.3)) || near[0];
      if (heir) {
        heir.memory.learn(key, {
          kind: 'recipe',
          confidence: 0.4 * (heir.genome.learning || 0.5),
          valence: 0.3,
          source: `last gift of ${dying.name}`,
        });
        this.archiveKnowledge(key);
      } else {
        this.lostKnowledge.push({
          key,
          tick: this.world.tick,
          who: dying.name,
          word: this.ont.get(key)?.word || key,
        });
        this.record(
          null,
          'loss',
          `How to make ${this.ont.get(key)?.word || key} was lost — ${dying.name} was the last who knew`,
          { valence: -0.5, intensity: 0.55 },
        );
      }
    }
  }

  die(a, cause = 'unknown') {
    if (!a.alive) return;
    a.alive = false;
    a.deathTick = this.world.tick;
    a.deathCause = cause;
    this.living = this.living.filter((x) => x.id !== a.id);
    this.dead.push(a);
    this.counters.deaths++;
    this.handOffKnowledge(a);

    this.world.corpses.push({
      id: a.id,
      name: a.name,
      x: a.x,
      y: a.y,
      tick: this.world.tick,
    });

    if (a.partner) {
      const p = this.byId(a.partner);
      if (p) p.partner = null;
    }

    for (const s of this.settlements) {
      if (s.championId === a.id) {
        const near = this.living
          .filter((x) => Math.hypot(x.x - s.x, x.y - s.y) < 20)
          .sort((x, y) => (y.reputation || 0) - (x.reputation || 0));
        s.championId = near[0]?.id || null;
      }
    }

    this.record(
      a,
      'death',
      `${a.name} died of ${cause} at ${Math.floor(a.ageAt(this.world.tick))}`,
      { valence: -0.8, intensity: 0.85, landmark: true },
    );
  }

  spoilFood() {
    for (const a of this.living) {
      for (const [k, v] of [...a.inventory]) {
        const c = this.ont.get(k);
        if (!c?.functions?.sustenance) continue;
        if (k === 'grain') continue;
        const loss = v * BALANCE.spoilRate * (this.world.season === 'summer' ? 1.4 : 1);
        if (loss > 0.02) a.take(k, Math.min(v, loss));
      }
    }
    for (const s of this.world.structuresOfKind('store')) {
      if (!s.stock) continue;
      for (const [k, v] of [...s.stock]) {
        if (k === 'grain' || k === 'water') continue;
        if (!this.ont.get(k)?.functions?.sustenance) continue;
        const loss = v * BALANCE.spoilRate * 0.5;
        if (loss > 0.02) s.stock.set(k, Math.max(0, v - loss));
      }
    }
  }

  // ── Tick ──────────────────────────────────────────────────────

  step(dt = 1) {
    this.tick += dt;
    this.world.tick = this.tick;
    this.world.step(dt);

    for (const a of this.living) {
      if (a.pregnant) {
        a.pregnant += dt / (YEAR_TICKS / 12);
        if (a.pregnant >= 9) this.birth(a);
      }
    }

    const ctxBase = {
      sim: this,
      world: this.world,
      ont: this.ont,
      rng: this.rng,
      nearby: (agent, r) => this.nearby(agent, r),
    };

    for (const a of [...this.living]) {
      if (!a.alive) continue;
      think(a, this, ctxBase);

      if (a.body.hunger >= 0.99) this.die(a, 'starvation');
      else if (a.body.thirst >= 0.99) this.die(a, 'thirst');
      else if (typeof a.health === 'function' && a.health() <= 0) {
        this.die(a, a.body.illness > a.body.injury ? 'illness' : 'injury');
      } else if (
        a.ageAt(this.world.tick) > 70 + (a.genome.resilience || 0.5) * 25 &&
        this.rng.bool(0.0015 * dt)
      ) {
        this.die(a, 'old age');
      }
    }

    if (this.tick % 6 === 0) this.fieldsTick();

    if (this.tick % 24 === 0) {
      this.dailyReflection();
      this.tryConceive();
      this.updateCampKnowledge();
      this.assignOrphans();
      this.spoilFood();
      this.refreshAllMarkets();
      this.aggregateNorms();
      for (const s of this.settlements) {
        this.refreshSettlementStats(s);
        this.syncProjects(s);
      }
      this.pickLeader();
      for (const a of this.living) {
        if (this.rng.bool(0.15)) this.tryLearnFromArchive(a);
      }
    }

    if (this.tick % YEAR_TICKS === 0) this.yearTurn();
    this.ritualPull *= 0.99;
  }

  fieldsTick() {
    for (const f of this.world.structuresOfKind('field')) {
      const fert = this.world.fertility?.[this.world.idx(f.x, f.y)] || 0.5;
      const seasonMul =
        this.world.season === 'winter'
          ? 0.12
          : this.world.season === 'spring'
            ? 1.15
            : this.world.season === 'summer'
              ? 1.25
              : 0.65;
      f.ripeness = clamp(
        (f.ripeness || 0) + (0.045 + (f.tended || 0) * 0.055) * fert * seasonMul,
      );
      f.tended = clamp((f.tended || 0) * 0.92);
    }
  }

  dailyReflection() {
    for (const a of this.living) {
      if (this.rng.bool(0.28)) a.memory.consolidate?.(a);
      for (const [k] of a.inventory) {
        const m = this.marketPrices.get(k);
        if (m && a.updateValue) a.updateValue(k, m.price, 0.06);
      }
    }
  }

  pickLeader() {
    if (!this.living.length || !this.origin) return;
    const ranked = [...this.living].sort(
      (x, y) =>
        (y.reputation || 0) + (y.genome.sociability || 0) * 0.2 -
        ((x.reputation || 0) + (x.genome.sociability || 0) * 0.2),
    );
    const lead = ranked[0];
    const s = this.origin;
    if (lead && s.championId !== lead.id && (lead.reputation || 0) > 0.55) {
      s.championId = lead.id;
      lead.titles = lead.titles || [];
      if (!lead.titles.includes('the one they listen to')) {
        lead.titles.push('the one they listen to');
        this.record(lead, 'first', `${lead.name} became the one they listen to`, {
          valence: 0.5,
          intensity: 0.8,
          landmark: true,
        });
      }
    }
  }

  yearTurn() {
    this.generation = Math.max(
      this.generation,
      Math.floor(this.world.year / 18) + 1,
    );
    const drift = this.lang.drift?.(this.rng);
    if (drift) {
      this.record(
        null,
        'language',
        `Their speech shifted: "${drift.from}" became "${drift.to}" in ${drift.changed} words`,
        { valence: 0, intensity: 0.5 },
      );
    }
    const cap = this.estimateCapability();
    if (cap > this.era.capability + 25) {
      this.era = {
        name: this.pickEraName(cap),
        started: this.world.tick,
        capability: cap,
      };
      this.record(null, 'era', `They entered ${this.era.name}`, {
        valence: 0.4,
        intensity: 0.6,
        landmark: true,
      });
    }
  }

  estimateCapability() {
    let c = 0;
    for (const a of this.living) {
      c += a.memory.knownKeys('recipe').length * 0.5;
    }
    c += this.archive.size * 2;
    c += this.world.structures.length * 1.5;
    return Math.round(c);
  }

  pickEraName(cap) {
    if (cap < 40) return 'the Age of Hands';
    if (cap < 80) return 'the Age of Fire';
    if (cap < 120) return 'the Age of Grain';
    if (cap < 160) return 'the Age of Metal';
    return 'the Age of Letters';
  }

  // ── Record & reports ──────────────────────────────────────────

  record(agent, kind, text, opts = {}) {
    const ev = {
      tick: this.world.tick,
      day: this.world.dayNumber,
      kind,
      text,
      agentId: agent?.id || null,
      name: agent?.name || null,
      ...opts,
    };
    this.chronicle?.add?.(ev);
    this.logBuffer.push(ev);
    this.eventLog.push(ev);
    if (this.eventLog.length > 4000) this.eventLog.shift();
    if (agent?.memory?.remember && !opts.quiet) {
      agent.memory.remember({
        tick: this.world.tick,
        kind,
        text,
        actors: opts.actors || [agent.id],
        valence: opts.valence || 0,
        intensity: opts.intensity || 0.3,
        concept: opts.concept || null,
      });
    }
  }

  drainLog() {
    const out = this.logBuffer;
    this.logBuffer = [];
    return out;
  }

  activityFeed(limit = 40) {
    return this.eventLog.slice(-limit).map((e) => ({
      day: e.day,
      kind: e.kind,
      text: e.text,
      name: e.name,
    }));
  }

  learningSummary() {
    const byFn = new Map();
    for (const key of this.archive) {
      const c = this.ont.get(key);
      if (!c) continue;
      const fn = c.bestFn || 'other';
      const score = c.serves?.(fn) || 0;
      const prev = byFn.get(fn);
      if (!prev || score > prev.score) {
        byFn.set(fn, { key, word: c.word, score });
      }
    }
    for (const a of this.living) {
      for (const key of a.memory.knownKeys('recipe')) {
        const c = this.ont.get(key);
        if (!c) continue;
        const fn = c.bestFn || 'other';
        const score = c.serves?.(fn) || 0;
        const prev = byFn.get(fn);
        if (!prev || score > prev.score) {
          byFn.set(fn, { key, word: c.word, score, holder: a.name });
        }
      }
    }
    return [...byFn.entries()]
      .map(([fn, v]) => ({ need: fn, ...v }))
      .sort((x, y) => y.score - x.score);
  }

  settlementReport(settlement = null) {
    const s = settlement || this.origin;
    if (!s) return null;
    this.refreshSettlementStats(s);
    this.syncProjects(s);
    const n = this.settlementNeeds(s);
    const structs = {};
    for (const st of this.world.structures) {
      if (Math.hypot(st.x - s.x, st.y - s.y) > 20) continue;
      structs[st.kind] = (structs[st.kind] || 0) + 1;
    }
    let storeFill = 0;
    let storeCap = 0;
    for (const st of this.world.structuresOfKind('store')) {
      if (Math.hypot(st.x - s.x, st.y - s.y) > 20) continue;
      for (const v of st.stock?.values() || []) {
        storeFill += v;
        storeCap += 40;
      }
    }
    return {
      name: s.name,
      stats: { ...s.stats },
      deficits: n,
      structures: structs,
      storeFillPct: storeCap ? Math.round((storeFill / storeCap) * 100) : 0,
      projects: s.projects.map((p) => ({
        kind: p.kind,
        label: p.label,
        progress: Math.round(p.progress * 10) / 10,
        target: p.target,
        done: !!p.done,
      })),
      leader: this.byId(s.championId)?.name || null,
      food: this.totalFood(),
      archiveSize: this.archive.size,
      crisis: this.foodCrisisLevel(s),
      laws: [...this.laws.entries()].map(([k, v]) => ({
        situation: k,
        label: v.label,
        strength: Math.round(v.strength * 100),
        polarity: v.polarity,
      })),
    };
  }

  societyReport() {
    const s = this.settlementReport();
    const ages = { child: 0, young: 0, adult: 0, mature: 0, elder: 0 };
    for (const a of this.living) {
      const age = a.ageAt(this.world.tick);
      if (age < 12) ages.child++;
      else if (age < 20) ages.young++;
      else if (age < 40) ages.adult++;
      else if (age < 60) ages.mature++;
      else ages.elder++;
    }
    const goods = this.living.map((a) => a.carried?.() || [...a.inventory.values()].reduce((x, y) => x + y, 0));
    const deathCauses = {};
    for (const a of this.dead) {
      const c = a.deathCause || 'unknown';
      deathCauses[c] = (deathCauses[c] || 0) + 1;
    }
    return {
      living: this.living.length,
      ever: this.agents.length,
      births: this.counters.births,
      deaths: this.counters.deaths,
      day: this.world.dayNumber,
      year: this.world.year,
      era: this.era.name,
      season: this.world.season,
      settlement: s,
      ages,
      archive: this.archive.size,
      campRecipes: [...this.campKnowledge.entries()].filter(
        ([, h]) => h.size >= BALANCE.campHolders,
      ).length,
      mood: mean(this.living.map((a) => a.affect?.mood || 0)),
      inequality: gini(goods),
      counters: { ...this.counters },
      lost: this.lostKnowledge.length,
      deathCauses,
      learning: this.learningSummary().slice(0, 16),
      recent: this.activityFeed(20),
    };
  }

  report() {
    if (typeof this.chronicle?.report === 'function') {
      return this.chronicle.report(this);
    }
    return this.societyReport();
  }
}

export { YEAR_TICKS, SKILLS, moodWord, BALANCE, NORM_LABELS };
