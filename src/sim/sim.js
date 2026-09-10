// The society layer: who knows whom, who owes whom, what is held to be wrong,
// who is buried where, and what the whole thing adds up to.
// Bridges are multi-tile spans (world.findBridgeSpan + raiseStructure).
// Knowledge: personal teach/handoff + institutional archive (no birth lock).

import { RNG } from '../core/rng.js';
import { Language } from '../core/language.js';
import { World, TERRAIN } from '../world/world.js';
import { Ontology } from './concepts.js';
import { Chronicle } from './chronicle.js';
import { Agent, YEAR_TICKS, SKILLS } from './agent.js';
import { randomGenome, inherit, genomeDistance, inventDna, inheritDna, dnaShare, dnaLabel, lineCensus, kinByDna } from './genome.js';
import { think, tickAgent, updateBody } from './mind.js';
import { appraise, dominantEmotion, moodWord } from './emotion.js';
import { clamp, dist, mean, topN, hueFor } from '../core/util.js';
import { STRUCTURE_KINDS } from './actions.js';

const BALANCE = {
  conceptionChance: 0.22,
  pregnancyTerm: 0.4,
  birthHealthCost: 0.06,
  grievanceInterval: 6,
  normsInterval: 24,
  spoilInterval: 24,
  rolesInterval: 12,
  chronicleInterval: 24,
  corpseDesiccation: 24 * 12,
  tradeCooldown: 30,
  fightCooldown: 60,
  neglectCooldown: 60,
  maxLogBuffer: 400,
  maxArtworks: 800,
  maxRituals: 200,
  maxBeliefs: 120,
  maxLostKnowledge: 300,
  maxBridgesPerCamp: 2,
};

const NORM_SEEDS = [
  { key: 'theft', label: 'what is not given must not be taken', polarity: -1 },
  { key: 'violence', label: 'hands are not raised against our own', polarity: -1 },
  { key: 'sharing', label: 'the hungry are fed from what we have', polarity: 1 },
  { key: 'burial', label: 'the dead are put into the ground with words', polarity: 1 },
  { key: 'teaching', label: 'what one knows, all may learn', polarity: 1 },
  { key: 'craft', label: 'a thing well made is owed respect', polarity: 1 },
];

export class Simulation {
  constructor(seed = 'aurorae', opts = {}) {
    this.seed = String(seed);
    this.rng = new RNG(this.seed);
    this.lang = new Language(this.rng);
    this.world = new World(this.rng, opts);
    this.ont = new Ontology(this.rng, this.lang);

    this.agents = [];
    this.livingCache = null;
    this.index = new Map();
    this.grid = new Map();
    this.logBuffer = [];

    this.norms = [];
    this.households = [];
    this.rituals = [];
    this.artworks = [];
    this.beliefs = [];
    this.marketPrices = new Map();
    this.lostKnowledge = [];
    this.inventionTicks = new Map();
    this.decisionLog = [];
    this._teachCool = new Map(); // observer samples {tick, name, goal, chose, why, also}
    this.techEffects = []; // advances with human-readable impact
    this.wantedMaterials = new Map();
    this.lexicon = new Map();
    this.archive = new Set();          // recipe keys that outlive individuals
    this.campKnowledge = new Map();    // key -> Set of living holder ids

    this.generation = 1;
    this.ritualPull = 0;
    this.counters = {
      births: 0, deaths: 0, trades: 0, conflicts: 0,
      thefts: 0, gifts: 0, rituals: 0, artworks: 0, lessons: 0,
    };
    this.paused = true;
    this._errCount = 0;

    this.settlements = [];
    this.seedPopulation(opts.population ?? 10);

    this.chronicle = new Chronicle(this.lang);
    this.record(null, 'era', `${this.lang.name} wakes on an unnamed shore`, {
      valence: 0.3, intensity: 1, landmark: true,
    });
  }

  get origin() { return this.settlements[0]; }
  get settlementName() { return this.settlements[0]?.name; }

  landReachable(sx, sy, maxSteps = 48) {
    const w = this.world;
    const seen = new Set();
    const q = [[sx, sy, 0]];
    const out = new Set([`${sx},${sy}`]);
    seen.add(`${sx},${sy}`);
    while (q.length) {
      const [x, y, d] = q.shift();
      if (d >= maxSteps) continue;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox;
        const ny = y + oy;
        const k = `${nx},${ny}`;
        if (seen.has(k) || !w.walkable(nx, ny)) continue;
        seen.add(k);
        out.add(k);
        q.push([nx, ny, d + 1]);
      }
    }
    return out;
  }

  riverBlocks(from, to, maxSteps = 70) {
    const w = this.world;
    const key = (x, y) => `${x},${y}`;
    const landOnly = (x, y) => {
      if (!w.inBounds(x, y)) return false;
      return w.at(x, y) > TERRAIN.MARSH;
    };
    const bfs = (pass) => {
      const seen = new Set([key(from.x | 0, from.y | 0)]);
      const q = [[from.x | 0, from.y | 0, 0]];
      while (q.length) {
        const [x, y, d] = q.shift();
        if (x === (to.x | 0) && y === (to.y | 0)) return true;
        if (d >= maxSteps) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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
    return !bfs(landOnly) && bfs((x, y) => w.walkable(x, y));
  }

  farBankTarget(a, radius = 22) {
    const sites = this.world.findBridgeSites?.(a.x, a.y, radius, 3, 10) || [];
    for (const s of sites) {
      for (const [dx, dy] of [
        [2, 0], [-2, 0], [0, 2], [0, -2],
        [3, 0], [-3, 0], [0, 3], [0, -3],
        [2, 2], [-2, -2], [2, -2], [-2, 2],
      ]) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (!this.world.inBounds(x, y)) continue;
        if (this.world.at(x, y) <= TERRAIN.MARSH) continue;
        if (Math.hypot(x - a.x, y - a.y) < 7) continue;
        if (this.riverBlocks(a, { x, y }, 50)) {
          return { x, y };
        }
      }
    }
    // Also try endLand of a known span blueprint
    const span = this.world.findBridgeSpan?.(a.x, a.y, radius, 14);
    if (span?.endLand) {
      if (this.riverBlocks(a, span.endLand, 50)) return span.endLand;
    }
    return null;
  }

  registerLex(surface, gloss, kind = 'concept', referentId = null) {
    if (!surface || this.lexicon.has(surface)) return;
    this.lexicon.set(surface, {
      gloss, kind, firstTick: this.world?.tick ?? 0, referentId,
    });
  }

  gloss(text) {
    if (!text) return text;
    let out = String(text);
    const entries = [...this.lexicon.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [surface, meta] of entries) {
      if (out.includes(surface)) out = out.split(surface).join(`${surface} (${meta.gloss})`);
    }
    return out;
  }

  plainSummary(ev) {
    const names = (ev.actors || []).map((id) => this.byId(id)?.name).filter(Boolean).join(', ');
    switch (ev.kind) {
      case 'birth': return `Birth: ${names}`;
      case 'death': {
        const cause = ev.text?.match(/died of (.+) at/)?.[1] || '?';
        return `Death: ${names} (${cause})`;
      }
      case 'bond': return `Bond: ${names}`;
      case 'trade': return `Trade: ${names}`;
      case 'theft': return `Theft: ${names}`;
      case 'violence': return `Fight: ${names}`;
      case 'invention': return `Invention: ${ev.concept || names}`;
      case 'teach': return `Teaching: ${names}${ev.concept ? ` (${ev.concept})` : ''}`;
      case 'gather': return `Gather: ${names}${ev.concept ? ` â ${ev.concept}` : ''}`;
      case 'build':
      case 'first': return `Build/first: ${(ev.text || '').slice(0, 90)}`;
      case 'speech': return `Said: ${ev.voice || names}: ${(ev.text || '').slice(0, 80)}`;
      case 'thought': return `Thought: ${ev.voice || names}: ${(ev.text || '').slice(0, 80)}`;
      case 'gift': return `Gift: ${names}`;
      case 'ritual': return `Ritual: ${names || 'collective'}`;
      case 'law':
      case 'custom': return `${ev.kind}: ${(ev.text || '').slice(0, 90)}`;
      case 'loss': return `Loss: ${(ev.text || '').slice(0, 90)}`;
      case 'era':
      case 'language': return `${ev.kind}: ${(ev.text || '').slice(0, 90)}`;
      default: return `${ev.kind}: ${(ev.text || '').slice(0, 100)}`;
    }
  }

  seedPopulation(n) {
    const { world, rng } = this;
    let cx = Math.floor(world.w / 2);
    let cy = Math.floor(world.h / 2);
    let best = -1;
    for (let i = 0; i < 900; i++) {
      const x = rng.int(6, world.w - 7);
      const y = rng.int(6, world.h - 7);
      if (!world.walkable(x, y)) continue;
      let score = 0;
      for (let oy = -4; oy <= 4; oy++) {
        for (let ox = -4; ox <= 4; ox++) {
          if (!world.inBounds(x + ox, y + oy)) continue;
          const t = world.at(x + ox, y + oy);
          if (t === TERRAIN.WATER) score += 3;
          if (t === TERRAIN.FOREST) score += 2;
          if (t === TERRAIN.MEADOW) score += 2;
          if (t === TERRAIN.ROCK || t === TERRAIN.HILL) score += 1;
        }
      }
      if (score > best) { best = score; cx = x; cy = y; }
    }

    const firstName = this.lang.placeName(rng);
    this.registerLex(firstName, 'founding shore-camp', 'place');
    const founding = {
      kind: 'settlement',
      id: 'set-0',
      name: firstName, x: cx, y: cy,
      foundedTick: 0, color: hueFor(0), tier: 'camp',
      archive: new Set(),
    };
    this.settlements = [founding];
    world.sites.push(founding);

    const reachable = this.landReachable(cx, cy, 40);

    for (let i = 0; i < n; i++) {
      let x = cx, y = cy, tries = 0;
      do {
        x = clamp(cx + rng.int(-4, 4), 1, world.w - 2);
        y = clamp(cy + rng.int(-4, 4), 1, world.h - 2);
        tries++;
      } while (
        (!world.walkable(x, y) || !reachable.has(`${x},${y}`)) &&
        tries < 60
      );
      if (!world.walkable(x, y) || !reachable.has(`${x},${y}`)) {
        x = cx;
        y = cy;
      }

      const g = randomGenome(rng);
      const personName = this.lang.personName(rng);
      this.registerLex(personName, 'founder', 'person');
      const dna = inventDna(rng, personName);

      const a = new Agent({
        name: personName, genome: g, dna, x, y, tick: 0, world, tongue: this.lang.name,
      });
      a.bornTick = -rng.int(16, 34) * YEAR_TICKS;
      a.body.hunger = 0.1;
      a.body.thirst = 0.08;
      a.body.health = 1;

      for (const c of this.ont.all()) {
        if (c.kind !== 'matter') continue;
        if (rng.bool(0.35 + g.curiosity * 0.3)) {
          a.memory.learn(c.key, {
            kind: 'matter', confidence: rng.float(0.3, 0.7), valence: 0.2, source: 'upbringing',
          });
        }
      }
      for (const food of ['berry', 'root', 'grain', 'water']) {
        a.memory.learn(food, {
          kind: 'matter', confidence: 0.9, valence: 0.5, source: 'upbringing',
        });
      }
      for (const seed of NORM_SEEDS) {
        if (rng.bool(0.2 + g.empathy * 0.15)) {
          a.memory.learn(`norm:${seed.key}`, {
            kind: 'norm',
            confidence: rng.float(0.08, 0.2),
            valence: seed.polarity > 0 ? 0.25 : -0.3,
            source: 'upbringing',
            payload: {
              situation: seed.key, polarity: seed.polarity, label: seed.label,
              evidence: 1, emergent: false,
            },
          });
        }
      }
      a.add('water', 22);
      a.add('berry', 28);
      a.add('root', 20);
      a.add('grain', 22);
      a.generation = 1;
      this.addAgent(a);
    }

    const storeWord = this.lang.word('struct:store');
    this.registerLex(storeWord, 'store', 'structure');
    this.world.addStructure({
      kind: 'store',
      x: cx,
      y: cy,
      word: storeWord,
      builtBy: 'founders',
      builtTick: 0,
      material: 'wood',
      condition: 1,
      settlementId: founding.id,
      stock: new Map([
        ['grain', 120],
        ['berry', 80],
        ['root', 70],
        ['water', 40],
        ['wood', 12],
        ['stone', 6],
        ['fibre', 14],
      ]),
    });
  }

  addAgent(a) {
    this.agents.push(a);
    this.index.set(a.id, a);
    a.worldTick = this.world.tick;
    this.livingCache = null;
    if (a.name) this.registerLex(a.name, a.role || 'person', 'person', a.id);
    return a;
  }

  get living() {
    if (!this.livingCache) this.livingCache = this.agents.filter((x) => x.alive);
    return this.livingCache;
  }

  get dead() { return this.agents.filter((x) => !x.alive); }

  byId(id) { return this.index.get(id); }

  rebuildGrid() {
    this.grid.clear();
    for (const a of this.living) {
      const k = `${a.x >> 2},${a.y >> 2}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(a);
    }
  }

  nearby(a, radius = 6) {
    const out = [];
    const r = Math.ceil(radius / 4);
    const gx = a.x >> 2, gy = a.y >> 2;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cell = this.grid.get(`${gx + dx},${gy + dy}`);
        if (!cell) continue;
        for (const o of cell) {
          if (o !== a && dist(a, o) <= radius) out.push(o);
        }
      }
    }
    return out;
  }

  step() {
    const w = this.world;
    w.step(1);
    this.livingCache = null;
    // Rebuild occupancy grid every other tick (nearby is approximate enough)
    if ((w.tick % 2) === 0) this.rebuildGrid();

    const ctx = {
      sim: this, world: w, ont: this.ont, rng: this.rng, tick: w.tick,
      nearby: (a, r) => this.nearby(a, r), bias: null,
    };

    // Staggered minds: few full propose() scans per tick; others continue/idle.
    const living = this.living;
    const n = living.length;
    // ~6-10 full brains regardless of N (urgent still jumps the queue)
    const budget =
      n <= 8 ? n : Math.max(5, Math.min(10, Math.ceil(90 / Math.max(1, Math.sqrt(n)))));
    this._thinkCursor = (this._thinkCursor || 0) % Math.max(1, n);
    for (let i = 0; i < n; i++) {
      const a = living[i];
      a.utterance = null;
      if (!a.alive) continue;
      const urgent =
        a.body.hunger > 0.82 ||
        a.body.thirst > 0.82 ||
        a.body.health < 0.25;
      const full =
        urgent ||
        ((i - this._thinkCursor + n) % n) < budget;
      try {
        tickAgent(a, ctx, full);
      } catch (e) {
        a.action = null;
        this._errCount = (this._errCount || 0) + 1;
        if (this._errCount <= 5 || this._errCount % 50 === 0) {
          console.error(`[mind error #${this._errCount}]`, e);
        }
      }
      if (a.body.health <= 0.001) this.die(a, this.causeOfDeath(a));
    }
    this._thinkCursor = (this._thinkCursor + budget) % Math.max(1, n);

    // Spread society systems across ticks
    if ((w.tick % 2) === 0) this.lifecycleTick();
    this.fieldsTick();
    if ((w.tick % 3) === 0) this.grievanceTick();
    if ((w.tick % 4) === 0) this.normsTick();
    this.corpseTick();
    if ((w.tick % 12) === 0) this.colonyTick();

    if (w.tick % BALANCE.spoilInterval === 0) this.spoilTick();
    if (w.tick % BALANCE.rolesInterval === 0) {
      this.updateRoles();
      this.updateWants();
    }
    if (w.tick % BALANCE.chronicleInterval === 0) {
      this.chronicle.sample(this);
      this.chronicle.maybeAdvanceEra(this);
      this.dailyReflection();
    }
    if (w.tick % YEAR_TICKS === 0) this.yearTurn();

    this.ritualPull = clamp(this.ritualPull - 0.004, 0, 2);
  }

  spoilTick() {
    const worldStore = this.ont.bestScoreFor?.('storage') || 0;
    const rot = (map, inStore = false) => {
      for (const [k, v] of map) {
        const c = this.ont.get(k);
        if (!c) continue;
        const food = c.serves('sustenance');
        if (food <= 0.15) continue;
        const keeps =
          (c.props.dry || 0) * 0.6 +
          (c.functions.storage || 0) * 0.4 +
          (inStore ? worldStore * 0.5 : 0);
        const rate = 0.015 * (1 - clamp(keeps, 0, 0.92));
        const left = v * (1 - rate);
        if (left < 0.05) map.delete(k);
        else map.set(k, left);
      }
    };
    for (const a of this.living) rot(a.inventory, false);
    for (const s of this.world.structuresOfKind('store')) if (s.stock) rot(s.stock, true);
  }

  causeOfDeath(a) {
    const b = a.body;
    const age = a.ageAt(this.world.tick);
    if (b.hunger > 0.85) return 'starvation';
    if (b.thirst > 0.85) return 'thirst';
    if (b.warmth < 0.2) return 'cold';
    if (b.injury > 0.5) return 'injury';
    if (b.illness > 0.5) return 'sickness';
    if (b.rest < 0.08) return 'exhaustion';
    if (age > 45) return 'old age';
    return 'failing health';
  }

  handOffKnowledge(a) {
    const recipes = a.memory.knownKeys('recipe');
    if (!recipes.length) return 0;

    const recipients = [];
    if (a.partner) {
      const p = this.byId(a.partner);
      if (p?.alive) recipients.push(p);
    }
    for (const cid of a.children || []) {
      const c = this.byId(cid);
      if (c?.alive && !(c.isChild?.(this.world.tick))) recipients.push(c);
    }
    const near = this.nearby(a, 10)
      .filter((o) => o.alive && !o.isChild(this.world.tick) && o.id !== a.id)
      .sort((x, y) => dist(a, x) - dist(a, y))
      .slice(0, 3);
    for (const o of near) {
      if (!recipients.includes(o)) recipients.push(o);
    }
    if (!recipients.length) return 0;

    let passed = 0;
    for (const key of recipes) {
      const holders = this.living.filter(
        (x) => x.id !== a.id && x.memory.knows(key, 0.25),
      ).length;
      if (holders > 1 && this.rng.bool(0.55)) continue;

      const belief = a.memory.belief(key);
      if (!belief) continue;

      const pupil =
        recipients.find((r) => !r.memory.knows(key, 0.25)) || recipients[0];
      if (!pupil || pupil.memory.knows(key, 0.4)) continue;

      pupil.memory.learn(key, {
        kind: 'recipe',
        confidence: Math.min(0.75, (belief.confidence || 0.5) * 0.7 * (pupil.genome.learning || 0.5)),
        valence: belief.valence ?? 0.4,
        source: `last words of ${a.name}`,
        payload: belief.payload,
      });
      pupil.stats.learned = (pupil.stats.learned || 0) + 1;
      a.stats.taught = (a.stats.taught || 0) + 1;
      this.counters.lessons++;
      passed++;

      const word = this.ont.get(key)?.word || key;
      this.record(
        a,
        'teach',
        `As ${a.name} failed, ${pupil.name} took the knowing of ${word}`,
        {
          actors: [a.id, pupil.id],
          valence: 0.35,
          intensity: 0.55,
          concept: key,
          quiet: true,
        },
      );
      this.archiveKnowledge(key);
    }
    return passed;
  }

  die(a, cause) {
    if (!a.alive) return;
    a.alive = false;
    a.deathTick = this.world.tick;
    a.deathCause = cause;
    this.livingCache = null;
    this.counters.deaths++;

    this.handOffKnowledge(a);
    if (a.householdId) {
      const h = this.households.find((x) => x.id === a.householdId);
      if (h) h.memberIds = h.memberIds.filter((id) => id !== a.id);
      a.householdId = null;
      this.pruneHouseholds();
    }

    for (const key of a.memory.knownKeys('recipe')) {
      if (this.isArchived(key)) continue;
      const stillKnown = this.living.some(
        (x) => x.id !== a.id && x.memory.knows(key, 0.2),
      );
      if (stillKnown) continue;
      const c = this.ont.get(key);
      const word = c?.word || key;
      this.lostKnowledge.push({
        key, word, lastKeeper: a.name, tick: this.world.tick,
      });
      if (this.lostKnowledge.length > BALANCE.maxLostKnowledge) {
        this.lostKnowledge.shift();
      }
      this.record(a, 'loss', `How to make ${word} was lost - ${a.name} was the last who knew`, {
        valence: -0.55,
        intensity: 0.7,
        concept: key,
        landmark: true,
      });
    }

    for (const [k, v] of [...a.inventory]) {
      if (v <= 0) continue;
      const near = this.nearby(a, 4).filter((o) => o.alive);
      if (near.length) {
        const taker = near[0];
        const n = Math.min(v, 3);
        a.take(k, n);
        taker.add(k, n);
      }
    }

    if (!this.world.corpses) this.world.corpses = [];
    this.world.corpses.push({
      id: a.id, name: a.name, x: a.x, y: a.y, tick: this.world.tick, cause,
    });

    if (a.partner) {
      const p = this.byId(a.partner);
      if (p) p.partner = null;
      a.partner = null;
    }

    const age = Math.max(0, a.ageAt(this.world.tick));
    this.record(
      a,
      'death',
      `${a.name} died of ${cause} at ${age < 1 ? 'an infant' : Math.round(age)}`,
      {
        valence: -0.8,
        intensity: 0.9,
        landmark: age > 30,
      },
    );
    this.chronicle.noteCause(cause);

    for (const o of this.nearby(a, 8)) {
      appraise(o, {
        goalCongruence: -0.35,
        agency: 'world',
        intensity: 0.4 + (o.rel(a).affection || 0) * 0.4,
        kind: 'death',
        social: a.id,
      });
    }
  }

  record(agent, kind, text, opts = {}) {
    const ev = {
      tick: this.world.tick,
      day: this.world.dayNumber,
      kind, text,
      actors: opts.actors || (agent ? [agent.id] : []),
      valence: opts.valence ?? 0,
      intensity: opts.intensity ?? 0.3,
      concept: opts.concept || null,
      landmark: !!opts.landmark,
      advance: !!opts.advance,
      quiet: !!opts.quiet,
      place: agent ? { x: agent.x, y: agent.y } : null,
      voice: opts.voice || null,
    };
    ev.plain = this.plainSummary(ev);
    ev.glossed = this.gloss(ev.text);
    this.chronicle.add(ev);
    if (!opts.quiet || opts.landmark) {
      this.logBuffer.push(ev);
      if (this.logBuffer.length > BALANCE.maxLogBuffer) {
        this.logBuffer.splice(0, this.logBuffer.length - BALANCE.maxLogBuffer);
      }
    }
    for (const id of ev.actors) {
      const a = this.byId(id);
      if (a) a.memory.remember(ev);
    }
    if (agent && (opts.intensity ?? 0) > 0.45) {
      for (const o of this.nearby(agent, 6)) {
        if (ev.actors.includes(o.id)) continue;
        o.memory.remember({
          ...ev, intensity: ev.intensity * 0.5,
          actors: ev.actors.concat(o.id), witnessed: true,
        });
      }
    }
    return ev;
  }

  converse(a, o) {
    const rng = this.rng;
    a.gainSkill('speak', 0.012);
    o.gainSkill('speak', 0.012);
    a.adjustRel(o, { familiarity: 0.05, trust: 0.012 });
    o.adjustRel(a, { familiarity: 0.05, trust: 0.012 });

    const pull = 0.06 * (a.genome.empathy + 0.3);
    o.affect.mood = clamp(o.affect.mood + (a.affect.mood - o.affect.mood) * pull, -1, 1);
    a.affect.mood = clamp(a.affect.mood + (o.affect.mood - a.affect.mood) * pull * 0.7, -1, 1);

    const rapport = (x, y) => clamp(
      0.02 +
        (1 - Math.abs(x.affect.mood - y.affect.mood)) * 0.02 +
        (1 - genomeDistance(x.genome, y.genome)) * 0.03 +
        x.genome.empathy * 0.015,
    );
    a.adjustRel(o, { affection: rapport(a, o) });
    o.adjustRel(a, { affection: rapport(o, a) });

    appraise(a, {
      goalCongruence: 0.2 + o.rel(a).affection * 0.3, agency: 'other',
      intensity: 0.3, kind: 'talk', social: o.id,
    });
    appraise(o, {
      goalCongruence: 0.2 + a.rel(o).affection * 0.3, agency: 'other',
      intensity: 0.3, kind: 'talk', social: a.id,
    });

    if (rng.bool(0.5)) {
      const topic = this.pickTopic(a, o);
      if (topic) {
        const text = this.utterance(a, o, topic);
        a.say?.(text);
        this.record(a, 'speech', text, {
          actors: [a.id, o.id], valence: topic.valence * 0.5, intensity: 0.3,
          voice: a.name, concept: topic.concept || null,
        });
        if (topic.transfer) {
          const b = a.memory.belief(topic.transfer);
          if (b) {
            o.memory.learn(topic.transfer, {
              kind: b.kind,
              confidence: b.confidence * 0.5 * (o.genome.learning || 0.5),
              valence: b.valence * 0.7,
              source: `told by ${a.name}`,
              payload: b.payload,
            });
            o.stats.learned = (o.stats.learned || 0) + 1;
            this.counters.lessons++;
          }
        }
        if (topic.gossipAbout) {
          const subject = topic.gossipAbout;
          const mine = a.rel(subject);
          const theirs = o.rel(subject);
          theirs.trust = clamp(theirs.trust + (mine.trust - theirs.trust) * 0.25);
          theirs.respect = clamp(theirs.respect + (mine.respect - theirs.respect) * 0.25);
          theirs.affection = clamp(theirs.affection + (mine.affection - theirs.affection) * 0.2, -1, 1);
          theirs.familiarity = clamp(theirs.familiarity + 0.03);
        }
      }
    }
  }

  pickTopic(a, o) {
    const options = [];
    for (const key of a.memory.knownKeys('recipe').slice(0, 12)) {
      if (!o.memory.knows(key, 0.3)) {
        options.push({
          kind: 'teach',
          transfer: key,
          concept: key,
          valence: 0.4,
          weight: 1.2 + (a.isElder(this.world.tick) ? 0.5 : 0),
        });
      }
    }
    for (const key of a.memory.knownKeys('place').slice(0, 6)) {
      options.push({
        kind: 'place',
        transfer: key,
        concept: key,
        valence: 0.2,
        weight: 0.6,
      });
    }
    const nearPeople = this.nearby(a, 12).filter((x) => x.id !== a.id && x.id !== o.id);
    if (nearPeople.length) {
      const subj = this.rng.pick(nearPeople);
      options.push({
        kind: 'gossip',
        gossipAbout: subj,
        valence: a.rel(subj).affection,
        weight: 0.5 + a.genome.sociability,
      });
    }
    options.push({ kind: 'mood', valence: a.affect.mood, weight: 0.4 });
    if (!options.length) return null;
    const total = options.reduce((s, t) => s + t.weight, 0);
    let r = this.rng.next() * total;
    for (const t of options) {
      r -= t.weight;
      if (r <= 0) return t;
    }
    return options[options.length - 1];
  }

  utterance(a, o, topic) {
    const name = o.name;
    if (topic.kind === 'teach' && topic.concept) {
      const word = this.ont.get(topic.concept)?.word || topic.concept;
      return `${a.name} shows ${name} the making of ${word}.`;
    }
    if (topic.kind === 'place' && topic.concept) {
      return `${a.name} tells ${name} of a place they know.`;
    }
    if (topic.kind === 'gossip' && topic.gossipAbout) {
      return `${a.name} speaks of ${topic.gossipAbout.name} with ${name}.`;
    }
    if (a.affect.mood > 0.3) return `${a.name} shares a quiet ease with ${name}.`;
    if (a.affect.mood < -0.3) return `${a.name} leans on ${name} in a hard hour.`;
    return `${a.name} and ${name} talk of the day.`;
  }

  teach(a, o, key) {
    const b = a.memory.belief(key);
    if (!b) return false;
    o.memory.learn(key, {
      kind: b.kind || 'recipe',
      confidence: Math.min(0.8, (b.confidence || 0.5) * 0.65 * (o.genome.learning || 0.5)),
      valence: b.valence ?? 0.3,
      source: `taught by ${a.name}`,
      payload: b.payload,
    });
    a.stats.taught = (a.stats.taught || 0) + 1;
    o.stats.learned = (o.stats.learned || 0) + 1;
    this.counters.lessons++;
    a.gainSkill?.('teach', 0.04);

    const c = this.ont.get(key);
    const word = c?.word || key;
    if (c?.bestFn) this.registerLex(word, c.bestFn, 'recipe', key);

    const holders = this.living.filter((x) => x.memory.knows(key, 0.25)).length;
    const rare = holders <= 3;
    this.record(a, 'teach', `${a.name} taught ${o.name} the making of ${word}`, {
      actors: [a.id, o.id],
      valence: 0.45,
      intensity: rare ? 0.5 : 0.25,
      concept: key,
      quiet: !rare && holders > 6,
    });
    if ((b.kind || 'recipe') === 'recipe' || this.ont.get(key)) {
      this.archiveKnowledge(key);
    }
    this.upholdNorm('teaching', 0.02);
    a.adjustRel(o, { affection: 0.04, familiarity: 0.05 });
    o.adjustRel(a, { trust: 0.06, affection: 0.05, familiarity: 0.05 });
    return true;
  }

  voiceThought(a, chosen) {
    if (!chosen) return;
    const text = `${a.name} thinks of ${chosen.kind}`;
    a.say?.(text);
    this.record(a, 'thought', text, {
      valence: 0, intensity: 0.2, voice: a.name, quiet: true,
    });
  }

  // ââ Households ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  /**
   * Household = couple + their dependent children.
   * Never merge two multi-member houses into a camp-wide clan.
   */
  formHousehold(a, o = null) {
    if (!a) return null;
    if (o && a.householdId && o.householdId && a.householdId === o.householdId) {
      return this.households.find((h) => h.id === a.householdId) || null;
    }

    // Pick a target house for the couple without swallowing unrelated members
    let targetId = null;
    const ha = a.householdId && this.households.find((h) => h.id === a.householdId);
    const hb = o?.householdId && this.households.find((h) => h.id === o.householdId);

    if (ha && !hb) targetId = ha.id;
    else if (hb && !ha) targetId = hb.id;
    else if (ha && hb && ha.id === hb.id) targetId = ha.id;
    else if (ha && hb) {
      // Both already housed separately: move only the couple (and minors) into
      // the house that already holds more of their children - never full merge.
      const childScore = (h, person) =>
        (person.children || []).filter(
          (id) => h.memberIds.includes(id) && this.byId(id)?.alive,
        ).length;
      const scoreA = childScore(ha, a) + childScore(ha, o);
      const scoreB = childScore(hb, a) + childScore(hb, o);
      targetId = scoreA >= scoreB ? ha.id : hb.id;
    }

    if (!targetId) {
      targetId = `h${this.households.length + 1}-${this.world.tick}`;
      const home = a.home || { x: a.x, y: a.y };
      const h = {
        id: targetId,
        foundedTick: this.world.tick,
        memberIds: [],
        home: { x: home.x, y: home.y },
        name: null,
      };
      this.households.push(h);
      const shelters = this.world.structuresOfKind?.('shelter') || [];
      let best = null;
      let bd = 8;
      for (const s of shelters) {
        const d = Math.hypot(s.x - a.x, s.y - a.y);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (best) h.home = { x: best.x, y: best.y };
    }

    this.joinHousehold(a, targetId);
    if (o) this.joinHousehold(o, targetId);

    // Dependent children of the couple follow
    const tick = this.world.tick;
    const bring = new Set([...(a.children || []), ...((o && o.children) || [])]);
    for (const cid of bring) {
      const c = this.byId(cid);
      if (c?.alive && c.isChild(tick)) this.joinHousehold(c, targetId);
    }

    const h = this.households.find((x) => x.id === targetId);
    if (h?.home) {
      a.home = { x: h.home.x, y: h.home.y };
      if (o) o.home = { x: h.home.x, y: h.home.y };
    }
    this.pruneHouseholds();
    return h || null;
  }

  joinHousehold(a, householdId) {
    const h = this.households.find((x) => x.id === householdId);
    if (!h || !a) return null;
    if (a.householdId && a.householdId !== householdId) {
      const prev = this.households.find((x) => x.id === a.householdId);
      if (prev) prev.memberIds = prev.memberIds.filter((id) => id !== a.id);
    }
    a.householdId = householdId;
    if (!h.memberIds.includes(a.id)) h.memberIds.push(a.id);
    if (h.home) a.home = { x: h.home.x, y: h.home.y };
    return h;
  }

  pruneHouseholds() {
    for (const h of this.households) {
      h.memberIds = h.memberIds.filter((id) => this.byId(id)?.alive);
    }
    this.households = this.households.filter((h) => h.memberIds.length > 0);
  }

  /** Backfill pairs/orphans that predate household logic or lost their house. */
  ensureHouseholdsFromBonds() {
    for (const a of this.living) {
      if (!a.partner) continue;
      const o = this.byId(a.partner);
      if (!o?.alive) continue;
      if (a.id > o.id) continue;
      if (a.householdId && o.householdId && a.householdId === o.householdId) continue;
      this.formHousehold(a, o);
    }
    const tick = this.world.tick;
    for (const a of this.living) {
      if (a.householdId) continue;
      const m = this.byId(a.motherId);
      const f = this.byId(a.fatherId);
      if (m?.alive && m.householdId) this.joinHousehold(a, m.householdId);
      else if (f?.alive && f.householdId) this.joinHousehold(a, f.householdId);
      else if (a.isChild(tick) && !a.householdId) {
        // Lone minor: small household of one so report stays honest
        this.formHousehold(a, null);
      }
    }
    this.pruneHouseholds();
  }

  tryBond(a, o) {

    if (!a.alive || !o.alive || a.partner || o.partner) return false;
    const ra = a.rel(o);
    const ro = o.rel(a);
    const want =
      ra.affection > 0.35 &&
      ro.affection > 0.3 &&
      ra.familiarity > 0.25 &&
      a.ageAt(this.world.tick) > 10 &&
      o.ageAt(this.world.tick) > 10;
    if (!want) return false;

    a.partner = o.id;
    o.partner = a.id;
    a.adjustRel(o, { affection: 0.2, trust: 0.15, familiarity: 0.1 });
    o.adjustRel(a, { affection: 0.2, trust: 0.15, familiarity: 0.1 });
    this.formHousehold(a, o);
    this.record(a, 'bond', `${a.name} and ${o.name} bound themselves to one another`, {
      actors: [a.id, o.id], valence: 0.8, intensity: 0.9, landmark: true,
    });
    appraise(a, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: o.id });
    appraise(o, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: a.id });
    return true;
  }

  /** Pull food/water from the nearest stocked store into the belly when critical. */
  /** Observer-facing summary of a built place. */
  /** Short visual reading of a place for the observer. */
  structureAppearance(s) {
    if (!s) return '';
    const mat = s.material
      ? (this.ont.get(s.material)?.word || s.material)
      : 'earth and hands';
    const cond = clamp(s.condition ?? 1, 0, 1);
    const wear =
      cond > 0.85 ? 'still sound' :
      cond > 0.6 ? 'weathered' :
      cond > 0.35 ? 'tired by wind and rain' :
      'near ruin';
    const kind = s.kind;
    if (kind === 'field') {
      const ripe = clamp(s.ripeness ?? 0, 0, 1);
      const crop =
        ripe > 0.85 ? 'standing grain ready to cut' :
        ripe > 0.45 ? 'green rows half-grown' :
        ripe > 0.15 ? 'turned earth with young shoots' :
        'bare turned ground';
      const care = (s.tended ?? 0) > 0.3 ? 'recently tended' : 'left alone of late';
      return `Open field of ${mat}: ${crop}, ${care}.`;
    }
    if (kind === 'shelter') {
      return `A low shelter of ${mat}, roof ${wear}.`;
    }
    if (kind === 'store') {
      return `A store-house of ${mat}, walls ${wear}.`;
    }
    if (kind === 'hearth') {
      return `A hearth ringed in ${mat}, fire-blackened stone.`;
    }
    if (kind === 'well') {
      return `A well lined with ${mat}, mouth open to the sky.`;
    }
    if (kind === 'bridge') {
      const n = s.spanLen ? `${s.spanLen} lengths of ` : '';
      return `A bridge of ${n}${mat} spanning the water, ${wear}.`;
    }
    if (kind === 'path') {
      return `Beaten path packed from ${mat}.`;
    }
    if (kind === 'shrine') {
      return `A shrine mark of ${mat}, ${wear}.`;
    }
    if (kind === 'hall') {
      return `A hall of ${mat}, broad roof ${wear}.`;
    }
    if (kind === 'workshop') {
      return `A workshop of ${mat}, tools left in the dust.`;
    }
    if (kind === 'plaza' || kind === 'market') {
      return `Open ${kind} ground edged with ${mat}.`;
    }
    return `A ${kind} of ${mat}, ${wear}.`;
  }

  /** Compact place line for small screens / map tip. */
  describeStructureShort(s) {
    if (!s) return '';
    const look = this.structureAppearance?.(s) || s.kind;
    const bits = [look];
    if (s.kind === 'field') {
      bits.push(
        `${Math.round(clamp(s.ripeness || 0, 0, 1) * 100)}% ripe` +
          ((s.tended || 0) < 0.2 ? ', untended' : ''),
      );
    } else if (s.condition != null) {
      bits.push(`${Math.round(clamp(s.condition, 0, 1) * 100)}%`);
    }
    if (s.builtBy) bits.push(`by ${s.builtBy}`);
    return bits.join('  -  ');
  }

  describeStructure(s) {
    if (!s) return 'Nothing stands here.';
    const day = Math.floor((s.builtTick ?? 0) / 24) + 1;
    const matWord = s.material
      ? (this.ont.get(s.material)?.word || s.material)
      : null;
    const lines = [
      `${s.word || s.kind} (${s.kind})`,
      this.structureAppearance(s),
      s.builtBy
        ? `Built by ${s.builtBy} on day ${day}`
        : `Standing since day ${day}`,
    ];
    if (matWord) lines.push(`Material: ${matWord}`);
    if (s.condition != null) {
      lines.push(`Condition: ${Math.round(clamp(s.condition, 0, 1) * 100)}%`);
    }
    if (s.kind === 'field') {
      lines.push(
        `Crop: ${Math.round(clamp(s.ripeness || 0, 0, 1) * 100)}% ripe` +
          (s.tended != null ? `, tended ${Math.round(clamp(s.tended, 0, 1) * 100)}%` : ''),
      );
    }
    if (s.stock && s.stock.size) {
      const held = [...s.stock.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${this.ont.get(k)?.word || k} x${Math.round(v)}`);
      if (held.length) lines.push(`Holds: ${held.join(', ')}`);
      else lines.push('Holds: empty');
    } else if (s.kind === 'store') {
      lines.push('Holds: empty');
    }
    if (s.occupants?.length) {
      const names = s.occupants
        .map((id) => this.byId(id))
        .filter((a) => a?.alive)
        .map((a) => a.name);
      if (names.length) lines.push(`Home to: ${names.slice(0, 5).join(', ')}`);
    }
    if (s.spanLen) lines.push(`Span: ${s.spanLen} lengths`);
    if (s.settlementId) {
      const st = this.settlements.find((x) => x.id === s.settlementId);
      if (st) lines.push(`Of ${st.name}`);
    }
    return lines.join(' | ');
  }

  emergencyFromStore(a) {
    if (!a?.alive) return false;
    const day = this.world.dayNumber || Math.floor(this.world.tick / 24) + 1;
    // First seasons: draw from stores earlier so founders do not starve mid-build
    const foodGate = day < 90 ? 0.28 : 0.36;
    const drinkGate = day < 90 ? 0.26 : 0.34;
    const needFood = a.body.hunger >= foodGate;
    const needDrink = a.body.thirst >= drinkGate;
    if (!needFood && !needDrink) return false;
    const stores = this.world.structuresOfKind('store').filter((s) => s.stock);
    if (!stores.length) return false;
    let store = null;
    let bd = Infinity;
    for (const s of stores) {
      const d = Math.hypot(s.x - a.x, s.y - a.y);
      if (d < bd) {
        bd = d;
        store = s;
      }
    }
    // Anywhere in the home region; stores are communal knowledge
    if (!store || bd > 48) return false;
    // Too far: bias them by setting a goal memory, still try if moderately close
    const take = (k, eat = false) => {
      const have = store.stock.get(k) || 0;
      if (have <= 0) return false;
      store.stock.set(k, Math.max(0, have - 1));
      if (eat) {
        const nut = this.ont.get(k)?.serves('sustenance') || 0.3;
        if (k === 'water') a.body.thirst = clamp(a.body.thirst - 0.65, 0, 1);
        else a.body.hunger = clamp(a.body.hunger - 0.4 - nut * 0.5, 0, 1);
      } else {
        a.add(k, 1);
      }
      return true;
    };
    if (needDrink) {
      if (take('water', true)) return true;
      for (const [k, v] of store.stock) {
        if (v > 0 && (this.ont.get(k)?.serves('sustenance') || 0) > 0.15) {
          if (take(k, true)) return true;
        }
      }
    }
    if (needFood) {
      let best = null;
      let bs = 0;
      for (const [k, v] of store.stock) {
        if (v <= 0) continue;
        const n = this.ont.get(k)?.serves('sustenance') || 0;
        if (n > bs) {
          bs = n;
          best = k;
        }
      }
      if (best && take(best, true)) return true;
    }
    return false;
  }

  lifecycleTick() {
    for (const a of this.living) {
      if (!a.alive) continue;
      const age = a.ageAt(this.world.tick);

      // Full granary must not coexist with routine starvation
      if (a.body.hunger >= 0.32 || a.body.thirst >= 0.3) {
        this.emergencyFromStore(a);
      }
      if (a.isChild(this.world.tick) && (a.body.hunger >= 0.28 || a.body.thirst >= 0.28)) {
        this.emergencyFromStore(a);
      }

      if (!a.isChild(this.world.tick)) {
        for (const cid of a.children || []) {
          const c = this.byId(cid);
          if (!c?.alive || !c.isChild(this.world.tick)) continue;
          if (dist(a, c) > 10) continue;

          if (c.body.hunger >= 0.35) {
            let food = null;
            for (const [k, v] of a.inventory) {
              if (v > 0 && (this.ont.get(k)?.serves('sustenance') || 0) > 0.15) {
                food = k;
                break;
              }
            }
            if (food && a.take(food, 1)) {
              c.add(food, 1);
              if (c.body.hunger > 0.5) {
                const nut = this.ont.get(food)?.serves('sustenance') || 0.3;
                c.body.hunger = clamp(c.body.hunger - 0.35 - nut * 0.4, 0, 1);
                c.take(food, 1);
              }
            }
          }
          if (c.body.thirst >= 0.4 && a.count('water') > 0 && a.take('water', 1)) {
            c.add('water', 1);
            c.body.thirst = clamp(c.body.thirst - 0.5, 0, 1);
          }
        }

        if (a.body.hunger < 0.55) {
          for (const c of this.nearby(a, 8)) {
            if (!c.isChild(this.world.tick) || !c.alive) continue;
            if (c.body.hunger < 0.45 && c.body.thirst < 0.45) continue;
            if (c.body.hunger >= 0.45) {
              let food = null;
              for (const [k, v] of a.inventory) {
                if (v > 0 && (this.ont.get(k)?.serves('sustenance') || 0) > 0.15) {
                  food = k;
                  break;
                }
              }
              if (food && a.take(food, 1)) {
                c.add(food, 1);
                c.body.hunger = clamp(c.body.hunger - 0.45, 0, 1);
              }
            }
            if (c.body.thirst >= 0.4 && a.count('water') > 0 && a.take('water', 1)) {
              c.add('water', 1);
              c.body.thirst = clamp(c.body.thirst - 0.5, 0, 1);
            }
          }
        }
      }

      if (
        a.partner &&
        !a.body.pregnant &&
        !a.isChild(this.world.tick) &&
        age >= 7 &&
        age < 36 &&
        a.body.hunger < 0.55 &&
        a.body.health > 0.4
      ) {
        const p = this.byId(a.partner);
        if (
          p?.alive &&
          !p.body.pregnant &&
          p.ageAt(this.world.tick) >= 7 &&
          p.ageAt(this.world.tick) < 36 &&
          p.body.hunger < 0.55 &&
          p.body.health > 0.35 &&
          dist(a, p) < 5
        ) {
          const tick = this.world.tick;
          const adults = this.living.filter(
            (x) => !x.isChild(tick) && x.ageAt(tick) >= 7,
          ).length;
          const children = this.living.filter(
            (x) => x.isChild(tick),
          ).length;
          const dep = adults > 0 ? children / adults : children;
          let chance =
            BALANCE.conceptionChance *
            ((a.genome.fertility + p.genome.fertility) / 2);
          // Recovery when the people are few
          if (this.living.length < 18) chance *= 1.6;
          if (this.living.length < 12) chance *= 1.35;
          if (dep > 4) chance *= 0.35;
          else if (dep > 2.5) chance *= 0.55;
          else if (dep > 1.5) chance *= 0.75;
          const ownKids = (a.children || [])
            .concat(p.children || [])
            .filter((id) => {
              const c = this.byId(id);
              return c?.alive && c.isChild(tick);
            }).length;
          if (ownKids >= 5) chance = 0;
          else if (ownKids >= 4) chance *= 0.1;
          else if (ownKids >= 3) chance *= 0.3;

          if (this.rng.bool(chance)) {
            const carrier = a.id < p.id ? a : p;
            carrier.body.pregnant = true;
            carrier.pregnantSince = this.world.tick;
            carrier.otherParentId = carrier === a ? p.id : a.id;
          }
        }
      }

      if (a.body.pregnant) {
        const term = (this.world.tick - (a.pregnantSince || 0)) / YEAR_TICKS;
        if (term >= BALANCE.pregnancyTerm) {
          this.birth(a, this.byId(a.otherParentId));
          a.body.pregnant = false;
          a.pregnantSince = null;
          a.otherParentId = null;
          a.body.health = clamp(a.body.health - BALANCE.birthHealthCost, 0.15, 1);
        }
      }
    }
  }

  birth(mother, father) {
    if (!mother?.alive) return null;
    const g = inherit(this.rng, mother.genome, father?.genome || mother.genome);
    const name = this.lang.personName(this.rng);
    this.registerLex(name, 'child', 'person');
    if (!mother.dna?.id) mother.dna = inventDna(this.rng, mother.name);
    if (father && !father.dna?.id) father.dna = inventDna(this.rng, father.name);
    const dna = inheritDna(this.rng, mother.dna, father?.dna || null);
    const child = new Agent({
      name,
      genome: g,
      dna,
      x: mother.x,
      y: mother.y,
      tick: this.world.tick,
      world: this.world,
      tongue: this.lang.name,
      generation: Math.max(mother.generation || 1, father?.generation || 1) + 1,
    });
    child.bornTick = this.world.tick;
    child.motherId = mother.id;
    child.fatherId = father?.id || null;
    child.parents = [mother.id, father?.id].filter(Boolean);
    if (mother.householdId) {
      this.joinHousehold(child, mother.householdId);
    } else if (father?.householdId) {
      this.joinHousehold(child, father.householdId);
    }
    child.body.hunger = 0.15;
    child.body.thirst = 0.1;
    child.body.health = 0.95;

    for (const food of ['berry', 'root', 'grain', 'water']) {
      child.memory.learn(food, {
        kind: 'matter', confidence: 0.7, valence: 0.5, source: 'upbringing',
      });
    }
    mother.children = mother.children || [];
    mother.children.push(child.id);
    if (father) {
      father.children = father.children || [];
      father.children.push(child.id);
    }

    child.add('berry', 4);
    child.add('water', 3);

    this.addAgent(child);
    this.counters.births++;
    // Cohort generation from parents (for demography reports)
    const parentGen = Math.max(
      mother.generation || 1,
      father?.generation || 1,
    );
    child.generation = parentGen + 1;
    this.generation = Math.max(this.generation, child.generation);

    this.record(
      mother,
      'birth',
      `${child.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''}` + (child.dna?.line ? ` - line ${child.dna.line}` : ''),
      {
        actors: [mother.id, child.id].concat(father ? [father.id] : []),
        valence: 0.85,
        intensity: 0.9,
        landmark: true,
      },
    );
    return child;
  }

  findDeal(a, o) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 2) continue;
      const desireO = o.desireFor?.(k, this.ont, this) || 0;
      if (desireO < 0.15) continue;
      for (const [j, w] of o.inventory) {
        if (w < 1) continue;
        const desireA = a.desireFor?.(j, this.ont, this) || 0;
        if (desireA < 0.1) continue;
        const gain = desireA - desireO * 0.3;
        if (gain > (best?.gain || 0.15)) {
          best = { give: k, take: j, nGive: 1, nTake: 1, gain };
        }
      }
    }
    return best;
  }

  settleTrade(a, o, deal) {
    if (!deal || !a.take(deal.give, deal.nGive)) return false;
    if (!o.take(deal.take, deal.nTake)) {
      a.add(deal.give, deal.nGive);
      return false;
    }
    a.add(deal.take, deal.nTake);
    o.add(deal.give, deal.nGive);
    a.stats.trades = (a.stats.trades || 0) + 1;
    o.stats.trades = (o.stats.trades || 0) + 1;
    this.counters.trades++;
    a.rel(o).lastTrade = this.world.tick;
    o.rel(a).lastTrade = this.world.tick;
    a.rel(o).exchanges = (a.rel(o).exchanges || 0) + 1;
    o.rel(a).exchanges = (o.rel(a).exchanges || 0) + 1;
    a.adjustRel(o, { trust: 0.04, familiarity: 0.03 });
    o.adjustRel(a, { trust: 0.04, familiarity: 0.03 });

    for (const key of [deal.give, deal.take]) {
      const mp = this.marketPrices.get(key) || { price: 1, volume: 0 };
      mp.volume = (mp.volume || 0) + 1;
      mp.price = clamp(mp.price * 0.98 + 0.02 * (1 + mp.volume * 0.01), 0.1, 200);
      this.marketPrices.set(key, mp);
      this.chronicle.notePrice(key, mp.price, this.world.tick);
    }

    const wa = this.ont.get(deal.give)?.word || deal.give;
    const wb = this.ont.get(deal.take)?.word || deal.take;
    this.record(a, 'trade', `${a.name} traded ${wa} for ${wb} with ${o.name}`, {
      actors: [a.id, o.id], valence: 0.3, intensity: 0.35,
    });
    return true;
  }

  onTheft(a, o, key, n) {
    this.counters.thefts++;
    a.adjustRel(o, { affection: -0.25, trust: -0.3 });
    o.adjustRel(a, { affection: -0.35, trust: -0.4, conflicts: (o.rel(a).conflicts || 0) + 1 });
    const word = this.ont.get(key)?.word || key;
    this.record(a, 'theft', `${a.name} took ${word} from ${o.name}`, {
      actors: [a.id, o.id], valence: -0.7, intensity: 0.7, concept: key,
    });
    this.violateNorm('theft', 0.08);
    appraise(o, {
      goalCongruence: -0.7, agency: 'other', intensity: 0.7, kind: 'theft', social: a.id, norm: -1,
    });
  }

  resolveFight(a, o) {
    a.lastFightTick = this.world.tick;
    o.lastFightTick = this.world.tick;
    this.counters.conflicts++;
    const power = (x) =>
      0.3 + x.body.energy * 0.4 + x.skills.fight * 0.8 + x.genome.aggression * 0.3;
    const pa = power(a);
    const po = power(o);
    const aWins = this.rng.next() < pa / (pa + po);
    const winner = aWins ? a : o;
    const loser = aWins ? o : a;
    loser.body.injury = clamp(loser.body.injury + this.rng.float(0.1, 0.35), 0, 1);
    loser.body.health = clamp(loser.body.health - 0.08, 0, 1);
    winner.gainSkill?.('fight', 0.04);
    a.adjustRel(o, { affection: -0.2, conflicts: (a.rel(o).conflicts || 0) + 1 });
    o.adjustRel(a, { affection: -0.2, conflicts: (o.rel(a).conflicts || 0) + 1 });
    this.record(a, 'violence', `${a.name} and ${o.name} came to blows; ${winner.name} stood`, {
      actors: [a.id, o.id], valence: -0.6, intensity: 0.8,
    });
    this.violateNorm('violence', 0.1);
    appraise(a, { goalCongruence: aWins ? 0.2 : -0.5, agency: 'self', intensity: 0.7, kind: 'violence' });
    appraise(o, { goalCongruence: !aWins ? 0.2 : -0.5, agency: 'self', intensity: 0.7, kind: 'violence' });
  }

  nearestSettlement(x, y) {
    let best = this.settlements[0];
    let bd = Infinity;
    for (const s of this.settlements) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  settlementNeeds(settlement) {
    const people = this.living.filter(
      (a) => Math.hypot(a.x - settlement.x, a.y - settlement.y) < 18,
    ).length;
    const count = (kind) =>
      this.world.structures.filter(
        (s) => s.kind === kind && Math.hypot(s.x - settlement.x, s.y - settlement.y) < 16,
      ).length;
    const need = (have, want) => clamp((want - have) / Math.max(1, want));

    const waterNear = this.world.waterNearCount?.(settlement.x, settlement.y, 14) ?? 0;
    const waterFar = this.world.waterNearCount?.(settlement.x, settlement.y, 22) ?? 0;
    const water = Math.max(waterNear, Math.floor(waterFar / 2));
    const bridgeSpans =
      this.world.bridgeSpanCount?.(settlement.x, settlement.y, 18) ?? count('bridge');
    const bridgesWanted =
      water < 4 ? 0 : Math.min(BALANCE.maxBridgesPerCamp, Math.max(1, Math.ceil(people / 25)));

    const corpsesNear = (this.world.corpses || []).filter(
      (c) => Math.hypot(c.x - settlement.x, c.y - settlement.y) < 20,
    ).length;
    const trades = this.counters?.exchanges || 0;

    const wantWorkshop = people >= 8 ? Math.min(2, 1 + Math.floor(people / 22)) : 0;
    const wantMarket = people >= 10 || trades > 100 ? Math.min(2, 1 + Math.floor(people / 28)) : 0;
    const wantShrine = (people >= 10 || corpsesNear >= 2) ? 1 : 0;
    const wantHall = people >= 12 ? 1 : 0;
    const wantPlaza = people >= 10 ? 1 : 0;
    const wantWell = people >= 8 ? Math.min(2, 1 + Math.floor(people / 24)) : 0;
    const wantField = Math.max(1, Math.min(5, Math.ceil(people / 12)));
    const wantShelter = Math.max(1, Math.ceil(people / 2.2));

    return {
      people,
      shelterDeficit: need(count('shelter'), wantShelter),
      hearthDeficit: need(count('hearth'), Math.max(1, Math.ceil(people / 10))),
      storeDeficit: need(count('store'), Math.max(1, Math.ceil(people / 16))),
      workshopDeficit: need(count('workshop'), wantWorkshop),
      fieldDeficit: need(count('field'), wantField),
      wellDeficit: need(count('well'), wantWell),
      shrineDeficit: need(count('shrine'), wantShrine),
      marketDeficit: need(count('market'), wantMarket),
      wallDeficit: need(count('wall'), people > 40 ? 1 : 0),
      hallDeficit: need(count('hall'), wantHall),
      bridgeDeficit: need(bridgeSpans, bridgesWanted),
      pathDeficit: need(count('path'), people >= 8 ? Math.ceil(people / 10) : 0),
      plazaDeficit: need(count('plaza'), wantPlaza),
      corpsesNear,
    };
  }

  settlementPressure(settlement) {
    if (!settlement) return 0;
    const n = this.settlementNeeds(settlement);
    const crowd = clamp(n.people / 40);
    const day = this.world.dayNumber || Math.floor(this.world.tick / 24) + 1;
    const sole =
      this.settlements.length <= 1 && n.people >= 14 && day >= 35 ? 0.28 : 0;
    const farOpen =
      day >= 45 &&
      this.farBankTarget({ x: settlement.x, y: settlement.y }, 26)
        ? 0.15
        : 0;
    return clamp(
      (
        n.shelterDeficit +
        n.storeDeficit +
        n.fieldDeficit +
        n.bridgeDeficit +
        (n.workshopDeficit || 0) +
        (n.marketDeficit || 0) +
        (n.hallDeficit || 0) +
        n.people / 55 +
        crowd +
        sole +
        farOpen
      ) / 5,
    );
  }

  /** Prefer founding when the home camp is stable enough - not only at huge N. */
  fissionUrge(settlement = null) {
    const home = settlement || this.origin;
    if (!home) return 0;
    if (this.settlements.length >= 5) return 0;
    const day = this.world.dayNumber || Math.floor(this.world.tick / 24) + 1;
    if (day < 28) return 0;

    // Count by nearest settlement so scatter does not zero the urge
    const people = this.living.filter((a) => {
      const n = this.nearestSettlement?.(a.x, a.y);
      return n && n.id === home.id;
    }).length;
    if (people < 14) return 0;

    const adults = this.living.filter((a) => {
      const n = this.nearestSettlement?.(a.x, a.y);
      if (!n || n.id !== home.id) return false;
      return !a.isChild?.(this.world.tick) && a.ageAt(this.world.tick) >= 7;
    }).length;
    if (adults < 6) return 0;

    const foodDays = this.foodDaysAt?.(home) ?? 0;
    const total = this.totalFood();
    // Allow founding even when packs hold food but the store is thin
    if (foodDays < 2 && total < people * 1.2) return 0;

    const spans =
      this.world.bridgeSpanCount?.(home.x, home.y, 22) ?? 0;
    const far = this.farBankTarget({ x: home.x, y: home.y }, 32);

    let urge = 0.12 + clamp((people - 12) / 40);
    if (spans >= 1) urge += 0.35;
    else if (far) urge += 0.2; // open bank - urge bridges then colony
    if (this.settlements.length === 1) urge += 0.25;
    if (foodDays >= 6 || total > people * 2) urge += 0.12;
    // Scatter itself is a signal: many far from the hearth
    const farFolk = this.living.filter(
      (a) => Math.hypot(a.x - home.x, a.y - home.y) > 14,
    ).length;
    if (farFolk >= 4) urge += 0.18;
    return clamp(urge);
  }

  bestBuildMaterial(a, fn) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 1) continue;
      const c = this.ont.get(k);
      if (!c) continue;
      const score = (c.serves?.(fn) || 0) + (c.props?.hard || 0) * 0.3 + (c.props?.flexible || 0) * 0.2;
      if (score > (best?.score || 0.05)) best = { key: k, score };
    }
    for (const k of ['wood', 'stone', 'clay', 'fibre', 'reed']) {
      if (a.count(k) > 0) {
        const score = 0.2;
        if (score > (best?.score || 0)) best = { key: k, score };
      }
    }
    for (const s of this.world.structuresOfKind('store')) {
      if (!s.stock || dist(a, s) > 14) continue;
      for (const [k, v] of s.stock) {
        if (v < 1) continue;
        const c = this.ont.get(k);
        if (!c) continue;
        const score = (c.serves?.(fn) || 0) * 0.9 + 0.15;
        if (score > (best?.score || 0.05)) best = { key: k, score };
      }
    }
    return best;
  }

  pickBuildSite(a, kind, settlement) {
    const base = settlement || this.nearestSettlement(a.x, a.y);
    const center = settlement?.farFocus
      ? settlement.farFocus
      : base;

    if (kind === 'bridge') {
      const span = this.world.findBridgeSpan?.(base.x, base.y, 26, 8);
      if (span?.tiles?.length) {
        return { x: span.tiles[0].x, y: span.tiles[0].y, span };
      }
      return null;
    }

    const ring =
      kind === 'field' ? 5 :
      kind === 'shelter' || kind === 'hearth' ? 3 :
      kind === 'store' || kind === 'well' ? 4 :
      kind === 'plaza' || kind === 'shrine' ? 6 :
      kind === 'workshop' ? 5 : 4;

    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = this.rng.float(0, Math.PI * 2);
      const rad = ring + this.rng.float(-1.5, 2.5);
      const x = clamp(Math.round(center.x + Math.cos(angle) * rad), 1, this.world.w - 2);
      const y = clamp(Math.round(center.y + Math.sin(angle) * rad), 1, this.world.h - 2);

      if (!this.world.walkable(x, y)) continue;
      if (this.world.structureAt(x, y)) continue;
      if (kind === 'field') {
        const t = this.world.at(x, y);
        if (t !== TERRAIN.MEADOW && t !== TERRAIN.GRASS) continue;
      }
      return { x, y };
    }

    for (let i = 0; i < 50; i++) {
      const x = clamp(center.x + this.rng.int(-10, 10), 1, this.world.w - 2);
      const y = clamp(center.y + this.rng.int(-10, 10), 1, this.world.h - 2);
      if (!this.world.walkable(x, y)) continue;
      if (this.world.structureAt(x, y)) continue;
      return { x, y };
    }
    return { x: Math.round(center.x), y: Math.round(center.y) };
  }


  /**
   * If several people are already living on a far bank (or a marked colony spot),
   * formalize a second settlement without waiting for a perfect expand action.
   */
  colonyTick() {
    if (!this.canFoundSettlement()) return;
    if (this.settlements.length >= 5) return;
    const day = this.world.dayNumber || Math.floor(this.world.tick / 24) + 1;
    if (day < 40) return;
    const origin = this.origin;
    if (!origin) return;

    // Prefer explicit spots created by bridges
    for (const spot of [...(this._colonySpots || [])].reverse()) {
      if (this.world.tick - spot.tick > 800) continue;
      let nearest = Infinity;
      for (const s of this.settlements) {
        nearest = Math.min(nearest, Math.hypot(s.x - spot.x, s.y - spot.y));
      }
      if (nearest < 11) continue;
      const here = this.living.filter(
        (a) => Math.hypot(a.x - spot.x, a.y - spot.y) < 10,
      );
      if (here.length >= 2) {
        const founder = here[0];
        this.foundSettlement(founder, { x: spot.x, y: spot.y });
        return;
      }
    }

    // Anyone river-blocked from origin counts as far-bank presence
    const farFolk = [];
    for (const a of this.living) {
      if (a.isChild?.(this.world.tick)) continue;
      if (Math.hypot(a.x - origin.x, a.y - origin.y) < 12) continue;
      if (this.riverBlocks(origin, a, 55)) farFolk.push(a);
    }
    if (farFolk.length < 2) return;
    // Cluster: use the median of far folk as a hearth
    const cx = Math.round(farFolk.reduce((s, a) => s + a.x, 0) / farFolk.length);
    const cy = Math.round(farFolk.reduce((s, a) => s + a.y, 0) / farFolk.length);
    if (!this.world.walkable(cx, cy)) return;
    let nearest = Infinity;
    for (const s of this.settlements) {
      nearest = Math.min(nearest, Math.hypot(s.x - cx, s.y - cy));
    }
    if (nearest < 11) return;
    this.foundSettlement(farFolk[0], { x: cx, y: cy });
  }

  /** Soft cap: do not found while the people are thin or camps are empty. */
  canFoundSettlement() {
    const n = this.living.length;
    const camps = this.settlements.length;
    if (n < 14) return false;
    // Roughly one camp per ~10 living (min 1)
    if (camps >= Math.max(1, Math.floor(n / 9) + 1)) return false;
    // Any ghost camp (<2 people) blocks further fission
    for (const st of this.settlements) {
      const here = this.living.filter(
        (a) => this.nearestSettlement(a.x, a.y) === st,
      ).length;
      if (here < 2 && camps >= 2) return false;
    }
    return true;
  }

  foundSettlement(a, spot) {
    if (!this.canFoundSettlement()) return this.nearestSettlement(spot.x, spot.y);
    // Avoid double-founding on top of an existing camp
    for (const s of this.settlements) {
      if (Math.hypot(s.x - spot.x, s.y - spot.y) < 11) return s;
    }
    const name = this.lang.placeName(this.rng);
    this.registerLex(name, 'new settlement', 'place');
    const settlement = {
      kind: 'settlement',
      id: `set-${this.settlements.length}-${this.world.tick}`,
      name,
      x: spot.x,
      y: spot.y,
      foundedTick: this.world.tick,
      color: hueFor(this.settlements.length),
      tier: 'camp',
      archive: new Set(this.archive),
      foundedBy: a?.id,
    };
    this.settlements.push(settlement);
    this.world.sites.push(settlement);

    const tag = (s) => {
      s.settlementId = settlement.id;
      return s;
    };

    // Bootstrap: store + shelter + hearth + field so a daughter camp is livable
    const place = (kind, x, y, extra = {}) => {
      if (!this.world.inBounds(x, y) || !this.world.walkable(x, y)) return;
      if (this.world.structureAt(x, y)) return;
      const word = this.lang.word(`struct:${kind}`);
      this.registerLex(word, kind, 'structure');
      this.world.addStructure(tag({
        kind,
        x, y,
        word,
        builtBy: a?.name || 'founders',
        builtTick: this.world.tick,
        material: 'wood',
        condition: 1,
        stock: kind === 'store'
          ? new Map([['grain', 28], ['berry', 14], ['water', 18], ['wood', 10], ['fibre', 6]])
          : new Map(),
        ripeness: kind === 'field' ? 0.2 : undefined,
        tended: kind === 'field' ? 0.4 : undefined,
        occupants: [],
        ...extra,
      }));
    };

    place('store', spot.x, spot.y);
    place('shelter', spot.x + 1, spot.y);
    place('shelter', spot.x - 1, spot.y);
    place('hearth', spot.x, spot.y + 1);
    place('field', spot.x + 2, spot.y);
    place('field', spot.x, spot.y - 2);

    this.record(a, 'first', `${a.name} founded ${name} across the land`, {
      valence: 0.7, intensity: 0.95, landmark: true,
    });
    appraise(a, { goalCongruence: 0.75, agency: 'self', intensity: 0.85, kind: 'first', novelty: 1 });
    this.reputationDelta(a, 0.08);
    if (a) {
      a.memory.learn(`where:${name}`, {
        kind: 'place',
        confidence: 0.8,
        valence: 0.6,
        payload: { x: spot.x, y: spot.y },
        source: 'founding',
      });
      a.home = { x: spot.x, y: spot.y };
      a.settlementId = settlement.id;
    }
    // Attract nearby wanderers to the new hearth
    for (const o of this.living) {
      if (Math.hypot(o.x - spot.x, o.y - spot.y) < 12) {
        o.settlementId = settlement.id;
        if (!o.home) o.home = { x: spot.x, y: spot.y };
      }
    }
    return settlement;
  }

  raiseStructure(a, kind, spot, materialKey) {
    const settlement = this.nearestSettlement(spot.x, spot.y);
    const word = this.lang.word(`struct:${kind}`);
    this.registerLex(word, kind, 'structure');

    // ââ Multi-tile bridge span âââââââââââââââââââââââââââââââââ
    if (kind === 'bridge') {
      const span =
        spot.span ||
        this.world.findBridgeSpan?.(spot.x, spot.y, 36, 14) ||
        this.world.findBridgeSpan?.(settlement.x, settlement.y, 36, 14);

      if (!span?.tiles?.length) return null;

      const spanId = `span-${this.world.tick}-${a.id}`;
      let first = null;
      for (const t of span.tiles) {
        if (this.world.structureAt(t.x, t.y)) continue;
        const s = {
          kind: 'bridge',
          x: t.x,
          y: t.y,
          word,
          builtBy: a.name,
          builtTick: this.world.tick,
          material: materialKey,
          condition: 1,
          stock: new Map(),
          occupants: [],
          spanId,
          spanLen: span.length,
          settlementId: settlement?.id || null,
        };
        this.world.addStructure(s);
        if (!first) first = s;
      }

      const spans = this.world.bridgeSpanCount?.(settlement.x, settlement.y, 22) ?? 1;
      const firstEver = spans <= 1;
      this.record(
        a,
        firstEver ? 'first' : 'build',
        firstEver
          ? `${a.name} spanned the water with ${word} - ${span.length} lengths of ${
              this.ont.get(materialKey)?.word || materialKey
            }`
          : `${a.name} raised a ${word} across the water (${span.length} lengths)`,
        { valence: 0.75, intensity: firstEver ? 0.95 : 0.55, landmark: firstEver },
      );
      // Mark the far bank as a place worth settling
      const end = span.endLand || span.tiles?.[span.tiles.length - 1];
      if (end && a) {
        this._colonySpots = this._colonySpots || [];
        this._colonySpots.push({
          x: end.x, y: end.y, tick: this.world.tick, by: a.id,
        });
        if (this._colonySpots.length > 12) this._colonySpots.shift();
        a.memory.learn('where:far-bank', {
          kind: 'place',
          confidence: 0.7,
          valence: 0.55,
          payload: { x: end.x, y: end.y },
          source: 'bridge',
        });
        a.memory.learn('lesson:cross', {
          kind: 'lesson', confidence: 0.45, valence: 0.5, source: 'experience',
          payload: { do: 'expand' },
        });
      }
      return first;
    }

    // ââ Ordinary structures ââââââââââââââââââââââââââââââââââââ
    const s = {
      kind,
      x: spot.x,
      y: spot.y,
      word,
      builtBy: a.name,
      builtTick: this.world.tick,
      material: materialKey,
      condition: 1,
      stock: new Map(),
      ripeness: kind === 'field' ? 0.15 : undefined,
      tended: kind === 'field' ? 0.3 : undefined,
      occupants: [],
      settlementId: settlement?.id || null,
    };
    this.world.addStructure(s);

    // Fission: distant structure founds a place only when the world is stable enough
    if (
      (kind === 'store' || kind === 'field' || kind === 'shelter' || kind === 'hearth') &&
      this.settlements.length < 5
    ) {
      const day = this.world.dayNumber || Math.floor(this.world.tick / 24) + 1;
      const alive = this.living.length;
      let nearest = Infinity;
      for (const st of this.settlements) {
        nearest = Math.min(nearest, Math.hypot(st.x - spot.x, st.y - spot.y));
      }
      if (nearest > 11 && day >= 30 && alive >= 12) {
        this.foundSettlement(a, { x: spot.x, y: spot.y });
      }
    }

    const existing = this.world.structuresOfKind(kind).length;
    const first = existing === 1;
    this.record(
      a,
      first ? 'first' : 'build',
      first
        ? `${a.name} raised the first ${word} of ${settlement.name} (${kind}) from ${
            this.ont.get(materialKey)?.word || materialKey
          }`
        : `${a.name} raised another ${kind} (${word})`,
      {
        valence: 0.7,
        intensity: first ? 0.95 : 0.25,
        landmark: first,
        quiet: !first, // only the first of each kind clutters the feed
      },
    );
    if (kind === 'shelter') {
      for (const o of this.living) {
        if (!o.home && dist(o, s) < 8) {
          o.home = s;
          s.occupants.push(o.id);
        }
      }
    }
    return s;
  }

  fieldsTick() {
    if (this.world.tick % 6) return;
    const growth =
      this.world.season === 'winter' ? 0.2 :
      this.world.season === 'summer' ? 1.25 :
      0.95;
    for (const f of this.world.structuresOfKind('field')) {
      const care = clamp(f.tended || 0);
      f.ripeness = clamp(
        (f.ripeness || 0) + 0.008 * growth * (0.5 + care),
        0, 1,
      );
      f.tended = Math.max(0, (f.tended || 0) - 0.02);
      const fi = this.world.idx(f.x, f.y);
      if (this.world.fertility) {
        if (care > 0.1) {
          this.world.fertility[fi] = clamp(this.world.fertility[fi] - 0.002, 0.15, 1);
        } else {
          this.world.fertility[fi] = clamp(this.world.fertility[fi] + 0.001, 0.15, 1);
        }
      }
    }
  }

  corpseTick() {
    if (this.world.tick % 24) return;
    for (const c of [...(this.world.corpses || [])]) {
      if (this.world.tick - c.tick > BALANCE.corpseDesiccation) {
        const idx = this.world.corpses.indexOf(c);
        if (idx >= 0) this.world.corpses.splice(idx, 1);
        this.record(null, 'loss', `${c.name} was never buried; the ground took them away`, {
          valence: -0.5, intensity: 0.6, landmark: true,
        });
        this.violateNorm('burial', 0.03);
      }
    }
  }

  bury(a, corpse) {
    const idx = (this.world.corpses || []).indexOf(corpse);
    if (idx < 0) return;
    this.world.corpses.splice(idx, 1);
    const dead = this.byId(corpse.id);
    if (dead) {
      dead.buried = true;
      dead.mourners = (dead.mourners || 0) + 1;
    }
    this.record(a, 'ritual', `${a.name} put ${corpse.name} into the ground with words`, {
      valence: 0.3, intensity: 0.6, actors: [a.id],
    });
    this.upholdNorm('burial', 0.05);
    appraise(a, { goalCongruence: 0.3, agency: 'self', intensity: 0.4, kind: 'burial', norm: 1 });
  }

  performRitual(a, site) {
    this.counters.rituals++;
    this.ritualPull = clamp(this.ritualPull + 0.15, 0, 2);
    a.affect.e.grief = clamp(a.affect.e.grief - 0.15, 0, 1);
    a.affect.e.awe = clamp(a.affect.e.awe + 0.1, 0, 1);
    this.rituals.push({ tick: this.world.tick, by: a.name, site: site?.kind || 'shrine' });
    if (this.rituals.length > BALANCE.maxRituals) this.rituals.shift();
    this.record(a, 'ritual', `${a.name} stood at the ${site?.word || 'shrine'}`, {
      valence: 0.25, intensity: 0.4,
    });
  }

  makeArt(a, mediumKey) {
    this.counters.artworks++;
    a.stats.crafted = (a.stats.crafted || 0) + 1;
    const word = this.lang.word('art:piece');
    this.registerLex(word, 'artwork', 'art');
    this.artworks.push({ tick: this.world.tick, by: a.name, medium: mediumKey, word });
    if (this.artworks.length > BALANCE.maxArtworks) this.artworks.shift();
    this.record(a, 'art', `${a.name} made ${word}`, {
      valence: 0.4, intensity: 0.4, quiet: true,
    });
    appraise(a, { goalCongruence: 0.35, agency: 'self', intensity: 0.35, kind: 'art' });
  }

  logDecision(a, reasoning, goal) {
    if (!this.decisionLog) this.decisionLog = [];
    const top = (reasoning || []).slice(0, 4);
    const chose = top[0];
    this.decisionLog.push({
      tick: this.world.tick,
      day: Math.floor(this.world.tick / 24) + 1,
      name: a.name,
      goal: goal || chose?.kind || 'acting',
      chose: chose?.kind,
      why: chose?.why || '',
      also: top.slice(1).map((r) => ({ kind: r.kind, why: r.why, u: r.u })),
    });
    if (this.decisionLog.length > 80) this.decisionLog.splice(0, this.decisionLog.length - 80);
  }

  onInvention(a, record, concept) {
    this.inventionTicks.set(concept.key, this.world.tick);
    if (concept.word && concept.bestFn) {
      this.registerLex(concept.word, concept.bestFn, 'invention', concept.key);
    }
    this.archiveKnowledge(concept.key);
    const fn = concept.bestFn;
    const score = concept.bestScore || concept.serves?.(fn) || 0;
    let effect = '';
    if (record?.advance && fn) {
      const hints = {
        sustenance: 'fields and meals will go further',
        cutting: 'work and harvest grow sharper',
        storage: 'food keeps longer in the store',
        heat: 'cold nights cost less',
        clothing: 'warmth holds on the body',
        furnace: 'harder makings come within reach',
        blade: 'cutting goes deeper',
        vessel: 'water and grain travel better',
        medicine: 'sickness may yield',
        weapon: 'the hunt has more force',
        shelter: 'walls stand easier',
        cordage: 'binding holds more load',
      };
      effect = hints[fn] ? ` - ${hints[fn]}` : ` - better ${fn}`;
      if (!this.techEffects) this.techEffects = [];
      this.techEffects.push({
        tick: this.world.tick,
        day: Math.floor(this.world.tick / 24) + 1,
        word: concept.word,
        fn,
        score,
        by: a.name,
        hint: hints[fn] || `better ${fn}`,
      });
      if (this.techEffects.length > 40) this.techEffects.shift();
      this.record(
        a,
        'thought',
        `Among them it was felt: ${concept.word} changes how they handle ${fn}`,
        { valence: 0.5, intensity: 0.55, concept: concept.key },
      );
    }
    this.record(
      a,
      'invention',
      `${a.name} made ${concept.word}${record?.advance ? ' - nothing they had served so well' : ''}${effect}`,
      {
        valence: record?.advance ? 0.85 : 0.4,
        intensity: record?.advance ? 0.9 : 0.45,
        concept: concept.key,
        advance: !!record?.advance,
        landmark: !!record?.advance,
        function: fn,
        score,
      },
    );
  }

  grievanceTick() {
    if (this.world.tick % BALANCE.grievanceInterval) return;
    for (const a of this.living) {
      if (a.isChild(this.world.tick) || a.body.hunger < 0.55) continue;
      for (const o of this.nearby(a, 6)) {
        if (o.isChild(this.world.tick)) continue;
        const r = a.rel(o);
        if (r.kin > 0.3 || r.affection > 0.2) continue;
        if (this.world.tick - (r.lastNeglect || -999) < BALANCE.neglectCooldown) continue;
        let surplus = 0;
        for (const [k, v] of o.inventory) {
          const c = this.ont.get(k);
          if (c?.functions.sustenance && v > 3) surplus += v - 3;
        }
        if (surplus < 2) continue;
        r.lastNeglect = this.world.tick;
        appraise(a, {
          goalCongruence: -0.4, agency: 'other', intensity: 0.4 + a.body.hunger * 0.3,
          kind: 'neglect', social: o.id,
        });
        a.adjustRel(o, { affection: -0.08, trust: -0.06 });
        a.memory.learn('norm:neglect', {
          kind: 'norm', confidence: 0.22, valence: -0.55, source: 'experience',
          payload: {
            situation: 'surplus-while-hungry', polarity: -1,
            label: 'the hungry are not left to watch the fed', evidence: 1,
          },
        });
        break;
      }
    }
  }

  personalNorm(a, key) {
    const b = a.memory.belief(`norm:${key}`);
    if (!b || b.confidence < 0.12) return 0;
    return b.valence * b.confidence;
  }

  effectiveNorm(a, key) {
    const personal = this.personalNorm(a, key);
    const social = this.normStrength(key);
    const socialSigned = social * (personal <= 0 ? -1 : 1);
    return personal * 0.65 + socialSigned * 0.35;
  }

  normStrength(key) {
    return this.norms.find((n) => n.key === key)?.strength || 0;
  }

  aggregateNorms() {
    const buckets = new Map();
    for (const a of this.living) {
      for (const b of a.memory.semantic.values()) {
        if (b.kind !== 'norm' || b.confidence < 0.15) continue;
        const k = b.key.replace(/^norm:/, '');
        const bucket = buckets.get(k) || { confs: [], vals: [], labels: [], holders: 0 };
        bucket.confs.push(b.confidence);
        bucket.vals.push(b.valence);
        if (b.payload?.label) bucket.labels.push(b.payload.label);
        bucket.holders++;
        buckets.set(k, bucket);
      }
    }
    for (const [key, b] of buckets) {
      const strength = mean(b.confs);
      const avgVal = mean(b.vals);
      const polarity = avgVal < 0 ? -1 : 1;
      const label =
        b.labels.sort(
          (x, y) =>
            b.labels.filter((z) => z === y).length - b.labels.filter((z) => z === x).length,
        )[0] || key;
      let n = this.norms.find((x) => x.key === key);
      if (!n) {
        n = {
          key, label, polarity, strength: 0.04,
          violations: 0, upholdings: 0, becameLaw: null, emergent: true,
        };
        this.norms.push(n);
        this.record(null, 'custom', `Something new began to be felt among them: ${label}`, {
          valence: polarity > 0 ? 0.2 : -0.2, intensity: 0.5, landmark: true,
        });
      } else {
        n.label = label;
        n.polarity = polarity;
      }
      n.strength = clamp(n.strength * 0.65 + strength * 0.35, 0, 1);
      n.holders = b.holders;
      this.checkLaw(n);
    }
  }

  normsTick() {
    if (this.world.tick % BALANCE.normsInterval) return;
    this.aggregateNorms();
    for (const n of this.norms) {
      n.strength = clamp(n.strength - 0.003, 0, 1);
      if (n.becameLaw && n.strength < 0.35) {
        n.becameLaw = null;
        this.record(null, 'law', `The rule slipped away: ${n.label}`, {
          valence: -0.3, intensity: 0.7, landmark: true,
        });
      }
    }
  }

  violateNorm(key, weight) {
    const n = this.norms.find((x) => x.key === key);
    if (!n) return;
    n.violations++;
    n.strength = clamp(
      n.strength + weight * (0.35 + mean(this.living, (a) => a.affect.e.disgust + a.affect.e.anger)),
    );
    this.checkLaw(n);
  }

  upholdNorm(key, weight) {
    const n = this.norms.find((x) => x.key === key);
    if (!n) return;
    n.upholdings++;
    n.strength = clamp(n.strength + weight);
    this.checkLaw(n);
  }

  checkLaw(n) {
    if (n.strength > 0.5 && !n.becameLaw) {
      n.becameLaw = this.world.tick;
      this.record(null, 'law', `It became a rule among them: ${n.label}`, {
        valence: 0.4, intensity: 0.9, landmark: true,
      });
    }
  }

  reputationDelta(a, d) { a.reputation = clamp(a.reputation + d, 0, 1); }

  respectFor(a) {
    return mean(this.living.filter((o) => o !== a), (o) => o.relationships.get(a.id)?.respect || 0);
  }

  leaders() {
    return topN(
      this.living.filter((a) => !a.isChild(this.world.tick)),
      3,
      (a) => this.respectFor(a) + a.reputation * 0.5,
    );
  }

  capabilityGaps(a) {
    const gaps = [];
    const want = [
      'cutting', 'heat', 'vessel', 'clothing', 'shelter', 'storage',
      'sustenance', 'weapon', 'medicine', 'record', 'art',
    ];
    for (const fn of want) {
      const mine = a.bestToolFor(fn, this.ont);
      const world = this.ont.bestScoreFor(fn);
      if (!mine || mine.score < 0.25 || world < 0.35) gaps.push(fn);
    }
    return gaps;
  }

  updateRoles() {
    this.ensureHouseholdsFromBonds();
    this.pruneHouseholds();
    for (const a of this.living) {
      if (a.isChild(this.world.tick)) { a.role = 'child'; continue; }
      const s = a.stats;
      const t = a.actionTally?.() || new Map();
      const recent = (kind) => t.get(kind) || 0;
      // Lifetime stats + recent behavior (recent weighted higher); trade damped
      const scores = [
        ['maker', s.inventions * 2.2 + a.skills.craft * 3 + recent('craft') * 2 + recent('experiment') * 2],
        ['forager', s.harvested * 0.05 + a.skills.forage * 3 + recent('gather') * 2.2],
        ['hunter', a.skills.hunt * 4 + recent('hunt') * 2.5],
        ['builder', s.built * 2.5 + a.skills.build * 3 + recent('build') * 2.5],
        ['farmer', a.skills.farm * 4.5 + recent('farm') * 3],
        ['healer', s.rescues * 2 + a.skills.heal * 3 + recent('care') * 2.5],
        // Lifetime taught counts less so a few lessons do not lock everyone as teacher
        ['teacher', s.taught * 0.35 + a.skills.teach * 2 + recent('teach') * 1.6],
        ['trader', s.trades * 0.4 + a.skills.trade * 2 + recent('trade') * 1.5],
        ['speaker', a.skills.speak * 2 + this.respectFor(a) * 3 + recent('converse') * 1],
        ['artist', s.crafted * 0.1 + a.skills.art * 4 + recent('makeArt') * 2.5],
      ];
      const best = topN(scores, 1, (x) => x[1])[0];
      a.role = best && best[1] > 2.0 ? best[0] : 'wanderer';
      if (a.isElder(this.world.tick) && a.skills.teach > 0.3 && !a.titles.includes('elder')) {
        a.titles.push('elder');
      }
    }
    const leaders = this.leaders();
    if (leaders[0] && this.respectFor(leaders[0]) > 0.4 && !leaders[0].titles.includes('the one they listen to')) {
      leaders[0].titles.push('the one they listen to');
      this.record(leaders[0], 'first', `${leaders[0].name} became the one they listen to`, {
        valence: 0.5, intensity: 0.8, landmark: true,
      });
    }
  }

  updateWants() {
    this.wantedMaterials.clear();
    for (const a of this.living) {
      for (const g of this.capabilityGaps(a)) {
        this.wantedMaterials.set(g, (this.wantedMaterials.get(g) || 0) + 1);
      }
    }
  }

  dailyReflection() {
    this.updateCampKnowledge();
    const living = this.living;
    const sample =
      living.length <= 14
        ? living
        : living.filter(() => this.rng.bool(14 / living.length));
    for (const a of sample) {
      if (this.rng.bool(0.22)) a.memory.consolidate(a);
      for (const [k] of a.inventory) {
        const m = this.marketPrices.get(k);
        if (m) a.updateValue?.(k, m.price, 0.08);
      }
      if (this.rng.bool(0.1)) this.tryLearnFromArchive(a);
    }
    // Weather and use wear places down slowly (inspector can show condition)
    for (const s of this.world.structures || []) {
      if (s.condition == null) s.condition = 1;
      const rate =
        s.kind === 'path' ? 0.0015 :
        s.kind === 'bridge' ? 0.0012 :
        s.kind === 'field' ? 0.0008 :
        0.001;
      s.condition = clamp(s.condition - rate * (this.world.weather === 'storm' ? 1.8 : 1), 0.15, 1);
    }
  }

  yearTurn() {
    const forgotten = this.ont.prune(this.living, 900);
    if (forgotten > 20) {
      this.record(null, 'era', `${forgotten} half-made curiosities passed out of memory`, {
        valence: -0.1, intensity: 0.4,
      });
    }
    this.generation = Math.max(this.generation, Math.floor(this.world.year / 18) + 1);
    const drift = this.lang.drift(this.rng);
    if (drift) {
      this.record(null, 'language', `Their speech shifted: "${drift.from}" became "${drift.to}" in ${drift.changed} words`, {
        valence: 0, intensity: 0.6,
      });
    }
  }

  /** Living people grouped by DNA line (observer). */

  /** Observer: one card per camp so large N stays readable. */
  settlementReports() {
    const out = [];
    for (const st of this.settlements || []) {
      // Membership by nearest camp (object identity) - not missing ids
      const members = this.living.filter((a) => {
        if (a.settlementId && st.id && a.settlementId === st.id) return true;
        const home = this.nearestSettlement?.(a.x, a.y);
        return home === st;
      });
      const n = members.length;
      const kinds = {};
      for (const s of this.world.structures || []) {
        const owner = s.settlementId
          ? this.settlements.find((x) => x.id === s.settlementId)
          : this.nearestSettlement(s.x, s.y);
        if (owner !== st) continue;
        kinds[s.kind] = (kinds[s.kind] || 0) + 1;
      }
      let storeFill = 0;
      let storeCap = 0;
      for (const s of this.world.structuresOfKind('store')) {
        const owner = s.settlementId
          ? this.settlements.find((x) => x.id === s.settlementId)
          : this.nearestSettlement(s.x, s.y);
        if (owner !== st || !s.stock) continue;
        for (const v of s.stock.values()) {
          storeFill += Math.max(0, v);
          storeCap += 40;
        }
      }
      const mood = n
        ? members.reduce((s, a) => s + (a.affect?.mood || 0), 0) / n
        : 0;
      const lines = lineCensus(members).slice(0, 5);
      const fd = this.foodDaysAt?.(st);
      out.push({
        id: st.id,
        name: st.name || 'camp',
        living: n,
        structures: kinds,
        structureCount: Object.values(kinds).reduce((a, b) => a + b, 0),
        storePct: storeCap ? Math.min(100, Math.round((100 * storeFill) / storeCap)) : 0,
        foodDays: fd != null ? Math.round(fd * 10) / 10 : null,
        mood: +mood.toFixed(2),
        lines,
      });
    }
    return out.sort((a, b) => b.living - a.living);
  }

  linesOfLiving() {
    // Backfill DNA for any agent missing it (old saves / missed founders)
    for (const a of this.living) {
      if (!a.dna?.id) {
        a.dna = inventDna(this.rng, a.name);
      }
    }
    return lineCensus(this.living);
  }

  kinOf(a, limit = 6) {
    return kinByDna(a, this.living, limit);
  }

  totalFood() {
    let t = 0;
    for (const a of this.living) {
      for (const [k, v] of a.inventory) {
        if (this.ont.get(k)?.functions.sustenance) t += v;
      }
    }
    for (const s of this.world.structuresOfKind('store')) {
      for (const [k, v] of s.stock || []) {
        if (this.ont.get(k)?.functions.sustenance) t += v;
      }
    }
    return Math.round(t);
  }

  /** Days of food near a settlement at ~1.1 measures / person / day. */
  foodDaysAt(settlement = null) {
    const s = settlement || this.origin;
    if (!s) return 0;
    const near = this.living.filter(
      (a) => Math.hypot(a.x - s.x, a.y - s.y) < 18,
    );
    const people = Math.max(1, near.length);
    let food = 0;
    for (const a of near) {
      for (const [k, v] of a.inventory) {
        if (this.ont.get(k)?.functions?.sustenance) food += v;
      }
    }
    for (const st of this.world.structuresOfKind('store')) {
      if (Math.hypot(st.x - s.x, st.y - s.y) > 16) continue;
      for (const [k, v] of st.stock || []) {
        if (this.ont.get(k)?.functions?.sustenance) food += v;
      }
    }
    return food / (people * 1.1);
  }

  archiveKnowledge(key) {
    if (!key) return;
    this.archive.add(key);
    for (const s of this.settlements) {
      if (!s.archive) s.archive = new Set();
      s.archive.add(key);
    }
  }

  isArchived(key) {
    return this.archive.has(key);
  }

  updateCampKnowledge() {
    this.campKnowledge.clear();
    for (const a of this.living) {
      if (!a.memory?.knownKeys) continue;
      for (const k of a.memory.knownKeys('recipe')) {
        if (!this.campKnowledge.has(k)) this.campKnowledge.set(k, new Set());
        this.campKnowledge.get(k).add(a.id);
      }
    }
    for (const [k, holders] of this.campKnowledge) {
      if (holders.size >= 2) this.archiveKnowledge(k);
    }
  }

  /** Quiet transfer of archived recipes near a store / workshop. */
  tryLearnFromArchive(a) {
    if (!this.archive.size) return;
    if (a.isChild?.(this.world.tick)) return;
    const nearStore =
      this.world.hasStructureNear?.(a.x, a.y, 'store', 7) ||
      this.world.hasStructureNear?.(a.x, a.y, 'workshop', 7) ||
      this.world.hasStructureNear?.(a.x, a.y, 'hall', 8);
    if (!nearStore) return;
    for (const key of this.archive) {
      if (a.memory.knows(key, 0.3)) continue;
      if (!this.ont.get(key)) continue;
      a.memory.learn(key, {
        kind: 'recipe',
        confidence: 0.28 * (a.genome.learning || 0.5),
        valence: 0.25,
        source: 'archive',
      });
      a.stats.learned = (a.stats.learned || 0) + 1;
      break;
    }
  }

  settlementReport(settlement = null) {
    const s = settlement || this.origin;
    if (!s) return null;
    const n = this.settlementNeeds(s);
    const structs = {};
    for (const st of this.world.structures) {
      if (Math.hypot(st.x - s.x, st.y - s.y) > 16) continue;
      structs[st.kind] = (structs[st.kind] || 0) + 1;
    }
    const spans = this.world.bridgeSpanCount?.(s.x, s.y, 18) ?? 0;
    const far = this.farBankTarget({ x: s.x, y: s.y }, 22);
    return {
      name: s.name,
      people: n.people,
      structures: structs,
      bridgeSpans: spans,
      deficits: n,
      farBankStillBlocked: !!far && spans === 0,
      food: this.totalFood(),
      foodDays: +this.foodDaysAt(s).toFixed(1),
      archiveSize: this.archive.size,
    };
  }

  inventionSummary(limit = 30) {
    const rows = [];
    for (const [key, tick] of this.inventionTicks) {
      const c = this.ont.get(key);
      if (!c) continue;
      const word = c.word || key;
      const lex = this.lexicon.get(word);
      rows.push({
        tick, key, word,
        gloss: lex?.gloss || c.bestFn || c.kind || 'invention',
        function: c.bestFn || null,
        tier: c.tier ?? null,
        uses: c.uses || 0,
        holders: this.living.filter((a) => a.memory.knows(key, 0.25)).length,
      });
    }
    return rows.sort((a, b) => b.tick - a.tick).slice(0, limit);
  }

  learningSummary() {
    const recipes = new Map();
    const matter = new Map();
    const norms = new Map();
    const places = new Map();

    for (const a of this.living) {
      for (const b of a.memory.semantic.values()) {
        if (b.confidence < 0.2) continue;
        let m = null;
        if (b.kind === 'recipe') m = recipes;
        else if (b.kind === 'matter' || b.kind === 'concept') m = matter;
        else if (b.kind === 'norm') m = norms;
        else if (b.kind === 'place') m = places;
        if (!m) continue;
        const cur = m.get(b.key) || { holders: 0, conf: 0, valence: 0 };
        cur.holders++;
        cur.conf += b.confidence;
        cur.valence += b.valence || 0;
        m.set(b.key, cur);
      }
    }

    const top = (map, n = 12) =>
      [...map.entries()]
        .map(([key, v]) => {
          const c = this.ont.get(key);
          const word = c?.word || key.replace(/^norm:/, '').replace(/^where:/, '');
          const lex = this.lexicon.get(c?.word || word);
          return {
            key, word,
            gloss: lex?.gloss || c?.bestFn || null,
            holders: v.holders,
            confidence: +(v.conf / v.holders).toFixed(2),
            valence: +(v.valence / v.holders).toFixed(2),
          };
        })
        .sort((a, b) => b.holders - a.holders || b.confidence - a.confidence)
        .slice(0, n);

    return {
      tick: this.world.tick,
      day: this.world.dayNumber,
      population: this.living.length,
      food: this.totalFood(),
      archive: this.archive.size,
      settlement: this.settlementReport(),
      topRecipes: top(recipes, 15),
      topMatter: top(matter, 15),
      topNorms: top(norms, 12),
      topPlaces: top(places, 8),
      inventions: this.inventionSummary(15),
      lost: this.lostKnowledge.slice(-12).map((L) => ({
        word: L.word, key: L.key, lastKeeper: L.lastKeeper, tick: L.tick,
      })),
    };
  }

  resourceSummary() {
    const inv = new Map();
    const add = (k, v) => inv.set(k, (inv.get(k) || 0) + v);

    for (const a of this.living) {
      for (const [k, v] of a.inventory) add(k, v);
    }
    for (const s of this.world.structuresOfKind('store')) {
      if (!s.stock) continue;
      for (const [k, v] of s.stock) add(k, v);
    }

    return [...inv.entries()]
      .map(([key, amount]) => {
        const c = this.ont.get(key);
        const word = c?.word || key;
        return {
          key, word,
          gloss: this.lexicon.get(word)?.gloss || c?.bestFn || null,
          amount: Math.round(amount * 10) / 10,
          sustenance: +(c?.serves('sustenance') || 0).toFixed(2),
          holders: this.living.filter((a) => a.count(key) > 0).length,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }

  inspectBeliefs(a) {
    const sem = [...a.memory.semantic.values()];
    const score = (b) => Math.abs(b.confidence * (b.valence || 0)) + b.confidence * 0.15;
    const take = (kind, n = 8) =>
      topN(kind ? sem.filter((b) => b.kind === kind) : sem, n, score).map((b) => ({
        key: b.key, kind: b.kind,
        confidence: +b.confidence.toFixed(2),
        valence: +(b.valence || 0).toFixed(2),
        source: b.source,
        age: (a.worldTick || this.world.tick) - (b.learnedAt || 0),
        payload: b.payload,
      }));
    return {
      id: a.id, name: a.name, role: a.role,
      mood: moodWord(a.affect.mood), emotion: dominantEmotion(a),
      goal: a.goal, action: a.action?.kind || null, reasoning: a.reasoning,
      dominant: take(null, 12), norms: take('norm', 10), lessons: take('lesson', 6),
      places: take('place', 6), recipes: take('recipe', 8), matter: take('matter', 8),
      recentEpisodes: a.memory.recall?.(() => true, 8)?.map((m) => ({
        kind: m.kind, text: m.text,
        salience: +m.salience.toFixed(2), valence: +m.valence.toFixed(2), tick: m.tick,
      })) || [],
      stats: a.memory.stats(),
    };
  }

  inspectNorms() {
    return this.norms
      .map((n) => ({
        key: n.key, label: n.label,
        strength: +n.strength.toFixed(2), polarity: n.polarity,
        holders: n.holders ?? this.living.filter((a) => a.memory.knows(`norm:${n.key}`, 0.15)).length,
        emergent: !!n.emergent, becameLaw: n.becameLaw,
        violations: n.violations, upholdings: n.upholdings,
      }))
      .sort((x, y) => y.strength - x.strength);
  }

  activityFeed(limit = 40) {
    return topN(
      this.living.filter((a) => a.action || a.goal),
      limit,
      (a) => (a.action ? 2 : 1) + a.body.hunger + a.body.thirst + (1 - a.body.health),
    ).map((a) => ({
      id: a.id, name: a.name, goal: a.goal || ' - ',
      action: a.action?.kind || 'idle', where: `${a.x},${a.y}`,
      emotion: dominantEmotion(a), mood: moodWord(a.affect.mood),
      why: a.reasoning?.[0]?.why || null,
      hunger: +a.body.hunger.toFixed(2), health: +a.body.health.toFixed(2),
    }));
  }

  recentLog(limit = 30, mode = 'plain') {
    return this.logBuffer.slice(-limit).map((ev) => {
      if (mode === 'glossed') return { ...ev, display: ev.glossed || ev.text };
      if (mode === 'native') return { ...ev, display: ev.text };
      return { ...ev, display: ev.plain || ev.text };
    });
  }

  drainLog() {
    const out = this.logBuffer;
    this.logBuffer = [];
    return out;
  }

  report() {
    return this.chronicle.report(this);
  }
}

export { YEAR_TICKS, SKILLS, moodWord, BALANCE, NORM_SEEDS };
