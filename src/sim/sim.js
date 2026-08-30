// The society layer: who knows whom, who owes whom, what is held to be wrong,
// who is buried where, and what the whole thing adds up to.

import { RNG } from '../core/rng.js';
import { Language } from '../core/language.js';
import { World, TERRAIN } from '../world/world.js';
import { Ontology } from './concepts.js';
import { Chronicle } from './chronicle.js';
import { Agent, YEAR_TICKS, SKILLS } from './agent.js';
import { randomGenome, inherit, genomeDistance } from './genome.js';
import { think } from './mind.js';
import { appraise, dominantEmotion, moodWord } from './emotion.js';
import { clamp, dist, mean, topN, hueFor } from '../core/util.js';
import { STRUCTURE_KINDS } from './actions.js';

const BALANCE = {
  conceptionChance: 0.15,
  pregnancyTerm: 0.7,
  birthHealthCost: 0.08,
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
    this.wantedMaterials = new Map();
    this.lexicon = new Map();

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
      case 'gather': return `Gather: ${names}${ev.concept ? ` → ${ev.concept}` : ''}`;
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
      kind: 'settlement', name: firstName, x: cx, y: cy,
      foundedTick: 0, color: hueFor(0), tier: 'camp',
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

      const a = new Agent({
        name: personName, genome: g, x, y, tick: 0, world, tongue: this.lang.name,
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
      a.add('water', 14);
      a.add('berry', 20);
      a.add('root', 14);
      a.add('grain', 14);
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
      stock: new Map([
        ['grain', 120],
        ['berry', 80],
        ['root', 70],
        ['water', 40],
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
    this.rebuildGrid();

    const ctx = {
      sim: this, world: w, ont: this.ont, rng: this.rng, tick: w.tick,
      nearby: (a, r) => this.nearby(a, r), bias: null,
    };

    for (const a of this.living) {
      a.utterance = null;
      if (!a.alive) continue;
      try { think(a, ctx); }
      catch (e) {
        a.action = null;
        this._errCount++;
        if (this._errCount <= 5 || this._errCount % 50 === 0) {
          console.error(`[mind error #${this._errCount}]`, e);
        }
      }
      if (a.body.health <= 0.001) this.die(a, this.causeOfDeath(a));
    }

    this.lifecycleTick();
    this.fieldsTick();
    this.grievanceTick();
    this.normsTick();
    this.corpseTick();

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
    const rot = (map) => {
      for (const [k, v] of map) {
        const c = this.ont.get(k);
        if (!c) continue;
        const food = c.serves('sustenance');
        if (food <= 0.15) continue;
        const keeps = (c.props.dry || 0) * 0.6 + (c.functions.storage || 0) * 0.4;
        const left = v * (1 - 0.015 * (1 - keeps));
        if (left < 0.05) map.delete(k);
        else map.set(k, left);
      }
    };
    for (const a of this.living) rot(a.inventory);
    for (const s of this.world.structuresOfKind('store')) if (s.stock) rot(s.stock);
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

  // ── Knowledge handoff on death ────────────────────────────────────────────

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

    for (const key of a.memory.knownKeys('recipe')) {
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
      this.record(a, 'loss', `How to make ${word} was lost — ${a.name} was the last who knew`, {
        valence: -0.55,
        intensity: 0.7,
        concept: key,
        landmark: true,
      });
    }

    // Drop useful goods nearby into a light "scavenge" for the living
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

  // ── Talk / teach ──────────────────────────────────────────────────────────

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

    this.record(a, 'teach', `${a.name} taught ${o.name} the making of ${word}`, {
      actors: [a.id, o.id],
      valence: 0.45,
      intensity: 0.45,
      concept: key,
    });
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

  // ── Bonding / birth / parental care ───────────────────────────────────────

  tryBond(a, o) {
    if (!a.alive || !o.alive || a.partner || o.partner) return false;
    const ra = a.rel(o);
    const ro = o.rel(a);
    const want =
      ra.affection > 0.35 &&
      ro.affection > 0.3 &&
      ra.familiarity > 0.25 &&
      a.ageAt(this.world.tick) > 15 &&
      o.ageAt(this.world.tick) > 15;
    if (!want) return false;

    a.partner = o.id;
    o.partner = a.id;
    a.adjustRel(o, { affection: 0.2, trust: 0.15, familiarity: 0.1 });
    o.adjustRel(a, { affection: 0.2, trust: 0.15, familiarity: 0.1 });
    this.record(a, 'bond', `${a.name} and ${o.name} bound themselves to one another`, {
      actors: [a.id, o.id], valence: 0.8, intensity: 0.9, landmark: true,
    });
    appraise(a, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: o.id });
    appraise(o, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: a.id });
    return true;
  }

  lifecycleTick() {
    for (const a of this.living) {
      if (!a.alive) continue;
      const age = a.ageAt(this.world.tick);

      // Parental share to children
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
                // soft auto-eat for very young
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
      }

      // Conception
      if (
        a.partner &&
        !a.body.pregnant &&
        !a.isChild(this.world.tick) &&
        age > 16 &&
        age < 48 &&
        a.body.hunger < 0.55 &&
        a.body.health > 0.45
      ) {
        const p = this.byId(a.partner);
        if (
          p?.alive &&
          !p.body.pregnant &&
          p.ageAt(this.world.tick) > 16 &&
          p.ageAt(this.world.tick) < 48 &&
          dist(a, p) < 4 &&
          this.rng.bool(BALANCE.conceptionChance * ((a.genome.fertility + p.genome.fertility) / 2))
        ) {
          // One of the pair carries — prefer lower id for stability
          const carrier = a.id < p.id ? a : p;
          carrier.body.pregnant = true;
          carrier.pregnantSince = this.world.tick;
          carrier.otherParentId = carrier === a ? p.id : a.id;
        }
      }

      // Birth
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
    const child = new Agent({
      name,
      genome: g,
      x: mother.x,
      y: mother.y,
      tick: this.world.tick,
      world: this.world,
      tongue: this.lang.name,
    });
    child.bornTick = this.world.tick;
    child.motherId = mother.id;
    child.fatherId = father?.id || null;
    child.parents = [mother.id, father?.id].filter(Boolean);
    child.body.hunger = 0.15;
    child.body.thirst = 0.1;
    child.body.health = 0.95;

    // Basic upbringing knowledge
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

    this.addAgent(child);
    this.counters.births++;
    this.record(
      mother,
      'birth',
      `${child.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''}`,
      {
        actors: [mother.id, child.id].concat(father ? [father.id] : []),
        valence: 0.85,
        intensity: 0.9,
        landmark: true,
      },
    );
    return child;
  }

  // ── Trade / fight / theft ─────────────────────────────────────────────────

  findDeal(a, o) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 2) continue;
      const ca = this.ont.get(k);
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

  // ── Settlements / structures ──────────────────────────────────────────────

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
    return {
      people,
      shelterDeficit: need(count('shelter'), Math.ceil(people / 3)),
      hearthDeficit: need(count('hearth'), Math.ceil(people / 8)),
      storeDeficit: need(count('store'), Math.max(1, Math.ceil(people / 20))),
      workshopDeficit: need(count('workshop'), people > 12 ? 1 : 0),
      fieldDeficit: need(count('field'), Math.ceil(people / 10)),
      wellDeficit: need(count('well'), people > 15 ? 1 : 0),
      shrineDeficit: need(count('shrine'), people > 20 ? 1 : 0),
      wallDeficit: need(count('wall'), people > 40 ? 1 : 0),
      hallDeficit: need(count('hall'), people > 30 ? 1 : 0),
      bridgeDeficit: need(count('bridge'), 0.2),
      pathDeficit: need(count('path'), people > 10 ? 1 : 0),
      plazaDeficit: need(count('plaza'), people > 25 ? 1 : 0),
    };
  }

  settlementPressure(settlement) {
    if (!settlement) return 0;
    const n = this.settlementNeeds(settlement);
    return clamp(
      (n.shelterDeficit + n.storeDeficit + n.fieldDeficit + n.people / 80) / 3,
    );
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
    // fallback common materials
    for (const k of ['wood', 'stone', 'clay', 'fibre']) {
      if (a.count(k) > 0) {
        const score = 0.2;
        if (score > (best?.score || 0)) best = { key: k, score };
      }
    }
    return best;
  }

  pickBuildSite(a, kind, settlement) {
    const center = settlement || this.nearestSettlement(a.x, a.y);
    for (let i = 0; i < 40; i++) {
      const x = clamp(center.x + this.rng.int(-6, 6), 1, this.world.w - 2);
      const y = clamp(center.y + this.rng.int(-6, 6), 1, this.world.h - 2);
      if (!this.world.walkable(x, y)) continue;
      const occ = this.world.structures.some((s) => s.x === x && s.y === y);
      if (occ) continue;
      return { x, y };
    }
    return { x: a.x, y: a.y };
  }

  foundSettlement(a, spot) {
    const name = this.lang.placeName(this.rng);
    this.registerLex(name, 'new settlement', 'place');
    const settlement = {
      kind: 'settlement',
      name,
      x: spot.x,
      y: spot.y,
      foundedTick: this.world.tick,
      color: hueFor(this.settlements.length),
      tier: 'camp',
    };
    this.settlements.push(settlement);
    this.world.sites.push(settlement);
    this.record(a, 'first', `${a.name} founded ${name}`, {
      valence: 0.6, intensity: 0.9, landmark: true,
    });
    appraise(a, { goalCongruence: 0.7, agency: 'self', intensity: 0.8, kind: 'first', novelty: 1 });
    this.reputationDelta(a, 0.06);
    return settlement;
  }

  raiseStructure(a, kind, spot, materialKey) {
    const settlement = this.nearestSettlement(spot.x, spot.y);
    const word = this.lang.word(`struct:${kind}`);
    this.registerLex(word, kind, 'structure');
    const s = {
      kind, x: spot.x, y: spot.y, word,
      builtBy: a.name, builtTick: this.world.tick, material: materialKey,
      condition: 1, stock: new Map(),
      ripeness: kind === 'field' ? 0 : undefined,
      occupants: [],
    };
    this.world.addStructure(s);
    const existing = this.world.structuresOfKind(kind).length;
    const first = existing === 1;
    this.record(
      a, first ? 'first' : 'build',
      first
        ? `${a.name} raised the first ${word} of ${settlement.name} — ${kind}, out of ${
            this.ont.get(materialKey)?.word || materialKey
          }`
        : `${a.name} raised a ${word}`,
      { valence: 0.7, intensity: first ? 0.95 : 0.5, landmark: first },
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
    const growth = this.world.season === 'winter' ? 0.15 : this.world.season === 'summer' ? 1.2 : 0.9;
    for (const f of this.world.structuresOfKind('field')) {
      const care = clamp(f.tended || 0);
      f.ripeness = clamp((f.ripeness || 0) + 0.006 * growth * (0.4 + care), 0, 1);
      f.tended = Math.max(0, (f.tended || 0) - 0.02);
    }
  }

  corpseTick() {
    if (this.world.tick % 24) return;
    for (const c of [...(this.world.corpses || [])]) {
      if (this.world.tick - c.tick > BALANCE.corpseDesiccation) {
        const idx = this.world.corpses.indexOf(c);
        if (idx >= 0) this.world.corpses.splice(idx, 1);
        this.record(null, 'loss', `${c.name} was never buried; the ground took them anyway`, {
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

  onInvention(a, record, concept) {
    this.inventionTicks.set(concept.key, this.world.tick);
    if (concept.word && concept.bestFn) {
      this.registerLex(concept.word, concept.bestFn, 'invention', concept.key);
    }
    this.record(
      a,
      'invention',
      `${a.name} made ${concept.word}${record?.advance ? ' — nothing they had served so well' : ''}`,
      {
        valence: record?.advance ? 0.85 : 0.4,
        intensity: record?.advance ? 0.9 : 0.45,
        concept: concept.key,
        advance: !!record?.advance,
        landmark: !!record?.advance,
      },
    );
  }

  // ── Norms ─────────────────────────────────────────────────────────────────

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
    for (const a of this.living) {
      if (a.isChild(this.world.tick)) { a.role = 'child'; continue; }
      const s = a.stats;
      const scores = [
        ['maker', s.inventions * 3 + a.skills.craft * 4],
        ['forager', s.harvested * 0.05 + a.skills.forage * 3],
        ['hunter', a.skills.hunt * 5],
        ['builder', s.built * 2 + a.skills.build * 4],
        ['farmer', a.skills.farm * 5],
        ['healer', s.rescues * 2 + a.skills.heal * 4],
        ['teacher', s.taught * 1.5 + a.skills.teach * 3],
        ['trader', s.trades * 0.7 + a.skills.trade * 3],
        ['speaker', a.skills.speak * 2 + this.respectFor(a) * 5],
        ['artist', s.crafted * 0.1 + a.skills.art * 5],
      ];
      const best = topN(scores, 1, (x) => x[1])[0];
      a.role = best && best[1] > 1.2 ? best[0] : 'wanderer';
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
    for (const a of this.living) {
      if (this.rng.bool(0.3)) a.memory.consolidate(a);
      for (const [k] of a.inventory) {
        const m = this.marketPrices.get(k);
        if (m) a.updateValue?.(k, m.price, 0.08);
      }
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

  // ── Inspect helpers ───────────────────────────────────────────────────────

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
      id: a.id, name: a.name, goal: a.goal || '—',
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
