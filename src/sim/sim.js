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
      // Strong starter packs — survive the first weeks
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
        a.say(text);
        this.record(a, 'speech', text, {
          actors: [a.id, o.id], valence: topic.valence * 0.5, intensity: 0.3,
          voice: a.name, concept: topic.concept || null,
        });
        if (topic.transfer) {
          const b = a.memory.belief(topic.transfer);
          if (b) {
            o.memory.learn(topic.transfer, {
              kind: b.kind,
              confidence: b.confidence * 0.5 * o.genome.learning,
              valence: b.valence * 0.7,
              source: `told by ${a.name}`,
              payload: b.payload,
            });
            o.stats.learned++;
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
    const rng = this.rng;
    const options = [];

    const places = a.memory.knownKeys('place');
    if (places.length) {
      options.push({ type: 'place', key: rng.pick(places), transfer: null, valence: 0.3 });
    }
    const recipes = a.memory.knownKeys('recipe').filter((k) => !o.memory.knows(k, 0.4));
    if (recipes.length) {
      const k = rng.pick(recipes);
      options.push({ type: 'recipe', key: k, transfer: k, concept: k, valence: 0.5 });
    }
    const matter = a.memory.knownKeys('matter').filter((k) => !o.memory.knows(k, 0.4));
    if (matter.length) {
      const k = rng.pick(matter);
      options.push({ type: 'matter', key: k, transfer: k, concept: k, valence: 0.3 });
    }
    const norms = a.memory.knownKeys('norm').filter((k) => !o.memory.knows(k, 0.35));
    if (norms.length && a.genome.empathy > 0.3) {
      const k = rng.pick(norms);
      options.push({
        type: 'norm', key: k, transfer: k, concept: k,
        valence: a.memory.belief(k)?.valence ?? 0,
      });
    }
    for (const other of this.nearby(a, 10)) {
      if (other === o || other === a) continue;
      const r = a.rel(other);
      if (Math.abs(r.trust) > 0.25 || Math.abs(r.affection) > 0.3) {
        options.push({
          type: 'gossip', key: other.id, gossipAbout: other, valence: r.affection, transfer: null,
        });
      }
    }
    if (!options.length) return null;
    return rng.pick(options);
  }

  utterance(a, o, topic) {
    const w = (k) => this.ont.get(k)?.word || k;
    switch (topic.type) {
      case 'place':
        return `${a.name} spoke of a place they knew beyond the ${this.world.season} ground`;
      case 'recipe':
        return `${a.name} told ${o.name} how ${w(topic.key)} is made`;
      case 'matter':
        return `${a.name} spoke of ${w(topic.key)} with ${o.name}`;
      case 'norm': {
        const b = a.memory.belief(topic.key);
        return `${a.name} said to ${o.name}: ${b?.payload?.label || topic.key}`;
      }
      case 'gossip':
        return `${a.name} spoke of ${topic.gossipAbout.name} to ${o.name}`;
      default:
        return `${a.name} spoke with ${o.name}`;
    }
  }

  teach(a, o, key) {
    const b = a.memory.belief(key);
    if (!b) return;
    o.memory.learn(key, {
      kind: b.kind,
      confidence: b.confidence * 0.55 * o.genome.learning,
      valence: b.valence * 0.8,
      source: `taught by ${a.name}`,
      payload: b.payload,
    });
    a.stats.taught++;
    o.stats.learned++;
    this.counters.lessons++;
    a.gainSkill('teach', 0.04);
    a.adjustRel(o, { affection: 0.04, respect: 0.03 });
    o.adjustRel(a, { affection: 0.06, trust: 0.05, respect: 0.08 });
    this.record(a, 'teach', `${a.name} taught ${o.name} of ${this.ont.get(key)?.word || key}`, {
      valence: 0.45, intensity: 0.4, actors: [a.id, o.id], concept: key,
    });
    appraise(a, { goalCongruence: 0.35, agency: 'self', intensity: 0.35, kind: 'teach', social: o.id });
    appraise(o, { goalCongruence: 0.4, agency: 'other', intensity: 0.4, kind: 'teach', social: a.id });
  }

  voiceThought(a, chosen) {
    const why = a.reasoning?.[0]?.why || a.goal || chosen.kind;
    const text = `${a.name} thought: ${why}`;
    a.utterance = text;
    this.record(a, 'thought', text, {
      valence: 0, intensity: 0.15, quiet: true, voice: a.name,
    });
  }

  lifecycleTick() {
    const w = this.world;
    const term = Math.floor(YEAR_TICKS * BALANCE.pregnancyTerm);

    for (const a of this.living) {
      if (a.body.pregnant) {
        a.body.pregnantTicks = (a.body.pregnantTicks || 0) + 1;
        if (a.body.pregnantTicks >= term) this.birth(a);
      }

      if (
        !a.body.pregnant &&
        a.partner &&
        a.ageAt(w.tick) > 16 &&
        a.ageAt(w.tick) < 45
      ) {
        const p = this.byId(a.partner);
        if (
          p &&
          p.alive &&
          !p.body.pregnant &&
          dist(a, p) < 14 &&
          a.body.health > 0.45 &&
          a.body.hunger < 0.9 &&
          p.body.hunger < 0.9 &&
          this.rng.bool(
            BALANCE.conceptionChance *
              ((a.genome.fertility + p.genome.fertility) / 2),
          )
        ) {
          const carrier = this.rng.bool(0.5) ? a : p;
          if (!carrier.body.pregnant) {
            carrier.body.pregnant = true;
            carrier.body.pregnantTicks = 0;
            carrier.body.otherParentId = carrier === a ? p.id : a.id;
          }
        }
      }
    }

    // Parental feed: food + water to children
    for (const a of this.living) {
      if (a.isChild(w.tick) || a.body.hunger > 0.65) continue;
      for (const cid of a.children || []) {
        const c = this.byId(cid);
        if (!c || !c.alive || !c.isChild(w.tick)) continue;
        if (c.body.hunger < 0.35 && c.body.thirst < 0.4) continue;
        if (dist(a, c) > 10) continue;

        if (c.body.hunger >= 0.35) {
          let foodKey = null;
          for (const [k, v] of a.inventory) {
            if (v > 0 && (this.ont.get(k)?.serves('sustenance') || 0) > 0.15) {
              foodKey = k;
              break;
            }
          }
          if (foodKey && a.take(foodKey, 1)) {
            c.add(foodKey, 1);
            c.body.hunger = clamp(c.body.hunger - 0.4, 0, 1);
          }
        }
        if (c.body.thirst >= 0.4 && a.count('water') > 0 && a.take('water', 1)) {
          c.add('water', 1);
          c.body.thirst = clamp(c.body.thirst - 0.5, 0, 1);
        }
      }
    }
  }

  tryBond(a, o) {
    if (a.partner || o.partner) return false;
    if (a.rel(o).kin > 0.5 || o.rel(a).kin > 0.5) return false;
    const ra = a.rel(o);
    const ro = o.rel(a);
    if (ra.affection < 0.18 || ro.affection < 0.15) return false;

    a.partner = o.id;
    o.partner = a.id;
    a.adjustRel(o, { affection: 0.2, trust: 0.1, familiarity: 0.15 });
    o.adjustRel(a, { affection: 0.2, trust: 0.1, familiarity: 0.15 });
    this.record(a, 'bond', `${a.name} and ${o.name} bound themselves to one another`, {
      valence: 0.7, intensity: 0.85, actors: [a.id, o.id], landmark: true,
    });
    appraise(a, {
      goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: o.id,
    });
    appraise(o, {
      goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'bond', social: a.id,
    });
    a.memory.learn(`norm:bond:${a.id}:${o.id}`, {
      kind: 'norm', confidence: 0.25, valence: 0.5, source: 'experience',
      payload: {
        situation: 'bond', polarity: 1,
        label: `${a.name} and ${o.name} bound themselves to one another`,
        evidence: 1,
      },
    });
    return true;
  }

  birth(mother) {
    const w = this.world;
    const otherId = mother.body.otherParentId;
    const other = otherId ? this.byId(otherId) : null;
    const g = inherit(
      this.rng,
      mother.genome,
      other?.genome || mother.genome,
      0.09,
    );
    const name = this.lang.personName(this.rng);
    this.registerLex(name, 'child', 'person');

    let x = mother.x;
    let y = mother.y;
    for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (w.walkable(mother.x + ox, mother.y + oy)) {
        x = mother.x + ox;
        y = mother.y + oy;
        break;
      }
    }

    const child = new Agent({
      name, genome: g, x, y, tick: w.tick, world: w, tongue: this.lang.name,
    });
    child.bornTick = w.tick;
    child.motherId = mother.id;
    child.fatherId = other?.id || null;
    child.body.hunger = 0.15;
    child.body.thirst = 0.1;
    child.body.health = 0.95;

    for (const food of ['berry', 'root', 'grain', 'water']) {
      child.memory.learn(food, {
        kind: 'matter', confidence: 0.55, valence: 0.4, source: 'upbringing',
      });
    }
    for (const b of mother.memory.semantic.values()) {
      if (b.kind === 'recipe' && this.rng.bool(0.25)) {
        child.memory.learn(b.key, {
          kind: b.kind, confidence: b.confidence * 0.3, valence: b.valence,
          source: 'upbringing', payload: b.payload,
        });
      }
    }

    child.add('berry', 6);
    child.add('root', 3);
    child.add('water', 4);

    mother.children = mother.children || [];
    mother.children.push(child.id);
    if (other) {
      other.children = other.children || [];
      other.children.push(child.id);
    }

    mother.body.pregnant = false;
    mother.body.pregnantTicks = 0;
    mother.body.otherParentId = null;
    mother.body.health = clamp(mother.body.health - BALANCE.birthHealthCost, 0.2, 1);
    mother.body.hunger = clamp(mother.body.hunger + 0.15, 0, 1);

    mother.adjustRel(child, { kin: 1, affection: 0.6, familiarity: 0.5 });
    child.adjustRel(mother, { kin: 1, affection: 0.5, familiarity: 0.4 });
    if (other) {
      other.adjustRel(child, { kin: 1, affection: 0.5, familiarity: 0.4 });
      child.adjustRel(other, { kin: 1, affection: 0.45, familiarity: 0.35 });
    }

    this.addAgent(child);
    this.counters.births++;
    const parentNames = other
      ? `${mother.name} and ${other.name}`
      : mother.name;
    this.record(mother, 'birth', `${child.name} was born to ${parentNames}`, {
      valence: 0.8, intensity: 0.9, actors: [mother.id, child.id].concat(other ? [other.id] : []),
      landmark: true,
    });
    appraise(mother, {
      goalCongruence: 0.7, agency: 'self', intensity: 0.8, kind: 'birth',
    });
  }

  die(a, cause = 'failing health') {
    if (!a.alive) return;
    a.alive = false;
    a.diedTick = this.world.tick;
    a.deathCause = cause;
    this.livingCache = null;
    this.counters.deaths++;

    if (a.partner) {
      const p = this.byId(a.partner);
      if (p) p.partner = null;
      a.partner = null;
    }

    this.world.corpses = this.world.corpses || [];
    this.world.corpses.push({
      id: a.id, name: a.name, x: a.x, y: a.y, tick: this.world.tick, cause,
    });

    for (const b of a.memory.semantic.values()) {
      if (b.kind !== 'recipe') continue;
      const holders = this.living.filter(
        (o) => o.id !== a.id && o.memory.knows(b.key, 0.25),
      );
      if (!holders.length) {
        const c = this.ont.get(b.key);
        this.lostKnowledge.push({
          key: b.key, word: c?.word || b.key, lastKeeper: a.name, tick: this.world.tick,
        });
        if (this.lostKnowledge.length > BALANCE.maxLostKnowledge) {
          this.lostKnowledge.splice(0, this.lostKnowledge.length - BALANCE.maxLostKnowledge);
        }
        this.record(a, 'loss', `How to make ${c?.word || b.key} was lost — ${a.name} was the last who knew`, {
          valence: -0.5, intensity: 0.7, concept: b.key, landmark: true,
        });
      }
    }

    const age = Math.floor(a.ageAt(this.world.tick));
    this.record(a, 'death', `${a.name} died of ${cause} at ${age}`, {
      valence: -0.8, intensity: 0.9, landmark: true,
    });
  }

  bury(a, corpse) {
    const idx = this.world.corpses.indexOf(corpse);
    if (idx >= 0) this.world.corpses.splice(idx, 1);
    this.upholdNorm('burial', 0.04);
    this.record(a, 'ritual', `${a.name} buried ${corpse.name} with words`, {
      valence: 0.3, intensity: 0.5, actors: [a.id],
    });
    appraise(a, {
      goalCongruence: 0.3, agency: 'self', intensity: 0.4, kind: 'burial', norm: 1,
    });
  }

  findDeal(a, o) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 2) continue;
      const ca = this.ont.get(k);
      if (!ca) continue;
      for (const [ok, ov] of o.inventory) {
        if (ok === k || ov < 1) continue;
        const co = this.ont.get(ok);
        if (!co) continue;
        const wantA = a.desireFor(ok, this.ont, this) - a.desireFor(k, this.ont, this);
        const wantO = o.desireFor(k, this.ont, this) - o.desireFor(ok, this.ont, this);
        if (wantA > 0.15 && wantO > 0.1) {
          const gain = wantA + wantO * 0.5;
          if (!best || gain > best.gain) {
            best = { give: k, take: ok, giveN: 1, takeN: 1, gain };
          }
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
    a.stats.trades++;
    o.stats.trades++;
    this.counters.trades++;
    a.rel(o).lastTrade = this.world.tick;
    o.rel(a).lastTrade = this.world.tick;
    a.adjustRel(o, { trust: 0.04, familiarity: 0.03 });
    o.adjustRel(a, { trust: 0.04, familiarity: 0.03 });
    this.record(a, 'trade', `${a.name} traded ${this.ont.get(deal.give)?.word || deal.give} with ${o.name} for ${this.ont.get(deal.take)?.word || deal.take}`, {
      valence: 0.3, intensity: 0.35, actors: [a.id, o.id],
    });
    for (const k of [deal.give, deal.take]) {
      const cur = this.marketPrices.get(k) || { price: 1, n: 0 };
      cur.n++;
      cur.price = cur.price * 0.9 + (deal.gain || 1) * 0.1;
      this.marketPrices.set(k, cur);
    }
  }

  onTheft(a, o, key, n) {
    this.counters.thefts++;
    a.adjustRel(o, { affection: -0.2, trust: -0.25 });
    o.adjustRel(a, { affection: -0.35, trust: -0.4 });
    this.violateNorm('theft', 0.06);
    this.record(a, 'theft', `${a.name} took ${this.ont.get(key)?.word || key} from ${o.name}`, {
      valence: -0.6, intensity: 0.7, actors: [a.id, o.id], concept: key,
    });
    appraise(o, {
      goalCongruence: -0.7, agency: 'other', intensity: 0.7, kind: 'theft', social: a.id, norm: -1,
    });
    appraise(a, {
      goalCongruence: 0.3, agency: 'self', intensity: 0.5, kind: 'theft', social: o.id, norm: -1,
    });
  }

  resolveFight(a, o) {
    a.lastFightTick = this.world.tick;
    o.lastFightTick = this.world.tick;
    this.counters.conflicts++;
    const aPower = 0.3 + a.skills.fight + a.body.energy * 0.3 + a.genome.aggression * 0.4;
    const oPower = 0.3 + o.skills.fight + o.body.energy * 0.3 + o.genome.aggression * 0.4;
    const aWin = this.rng.next() < aPower / (aPower + oPower);
    const winner = aWin ? a : o;
    const loser = aWin ? o : a;
    loser.body.injury = clamp(loser.body.injury + this.rng.float(0.1, 0.35), 0, 1);
    loser.body.health = clamp(loser.body.health - 0.08, 0, 1);
    winner.gainSkill('fight', 0.04);
    a.adjustRel(o, { affection: -0.25, trust: -0.2 });
    o.adjustRel(a, { affection: -0.25, trust: -0.2 });
    a.rel(o).conflicts = (a.rel(o).conflicts || 0) + 1;
    o.rel(a).conflicts = (o.rel(a).conflicts || 0) + 1;
    this.violateNorm('violence', 0.05);
    this.record(a, 'violence', `${a.name} and ${o.name} came to blows; ${winner.name} prevailed`, {
      valence: -0.6, intensity: 0.8, actors: [a.id, o.id],
    });
    appraise(a, {
      goalCongruence: aWin ? 0.3 : -0.5, agency: 'self', intensity: 0.7, kind: 'violence', social: o.id,
    });
    appraise(o, {
      goalCongruence: aWin ? -0.5 : 0.3, agency: 'self', intensity: 0.7, kind: 'violence', social: a.id,
    });
  }

  onInvention(a, record, concept) {
    this.inventionTicks.set(concept.key, this.world.tick);
    this.record(a, 'invention',
      record?.advance
        ? `${a.name} made ${concept.word} — nothing they had served ${concept.bestFn} so well`
        : `${a.name} made ${concept.word}, a ${concept.bestFn} of sorts, no better than what they had`,
      {
        valence: record?.advance ? 0.7 : 0.35,
        intensity: record?.advance ? 0.85 : 0.4,
        concept: concept.key,
        advance: !!record?.advance,
        landmark: !!record?.advance,
      },
    );
  }

  makeArt(a, mediumKey) {
    const piece = {
      maker: a.name, makerId: a.id, tick: this.world.tick,
      medium: mediumKey, word: this.lang.word('art'),
    };
    this.artworks.push(piece);
    if (this.artworks.length > BALANCE.maxArtworks) {
      this.artworks.splice(0, this.artworks.length - BALANCE.maxArtworks);
    }
    this.counters.artworks++;
    a.stats.crafted++;
    this.record(a, 'art', `${a.name} made something for its own sake`, {
      valence: 0.4, intensity: 0.35, quiet: true,
    });
    appraise(a, {
      goalCongruence: 0.4, agency: 'self', intensity: 0.4, kind: 'makeArt',
    });
  }

  performRitual(a, site) {
    this.rituals.push({ agent: a.name, site: site?.word || 'ground', tick: this.world.tick });
    if (this.rituals.length > BALANCE.maxRituals) {
      this.rituals.splice(0, this.rituals.length - BALANCE.maxRituals);
    }
    this.counters.rituals++;
    this.ritualPull = clamp(this.ritualPull + 0.15, 0, 2);
    a.affect.e.grief = clamp(a.affect.e.grief - 0.2, 0, 1);
    a.affect.e.awe = clamp(a.affect.e.awe + 0.15, 0, 1);
    this.record(a, 'ritual', `${a.name} stood in ritual at the ${site?.word || 'ground'}`, {
      valence: 0.25, intensity: 0.4,
    });
  }

  nearestSettlement(x, y) {
    return topN(this.settlements, 1, (s) => -dist({ x, y }, s))[0] || this.settlements[0];
  }

  settlementPressure(s) {
    if (!s) return 0;
    const near = this.living.filter((a) => dist(a, s) < 16).length;
    const capacity = 8 + this.world.structuresOfKind('shelter').filter((x) => dist(x, s) < 12).length * 3;
    return clamp(near / Math.max(1, capacity) - 0.5);
  }

  settlementNeeds(s) {
    if (!s) {
      return {
        shelterDeficit: 1, hearthDeficit: 1, storeDeficit: 1, workshopDeficit: 0.5,
        fieldDeficit: 0.5, wellDeficit: 0.4, shrineDeficit: 0.3, wallDeficit: 0.1,
        hallDeficit: 0.1, bridgeDeficit: 0.2, pathDeficit: 0.3, plazaDeficit: 0.2,
      };
    }
    const near = (kind) =>
      this.world.structuresOfKind(kind).filter((x) => dist(x, s) < 14).length;
    const pop = this.living.filter((a) => dist(a, s) < 16).length;
    return {
      shelterDeficit: clamp(1 - near('shelter') / Math.max(1, pop * 0.4)),
      hearthDeficit: clamp(1 - near('hearth') / Math.max(1, pop * 0.3)),
      storeDeficit: clamp(1 - near('store') / Math.max(1, 1 + pop * 0.1)),
      workshopDeficit: clamp(0.8 - near('workshop') * 0.5),
      fieldDeficit: clamp(0.9 - near('field') * 0.35),
      wellDeficit: clamp(0.7 - near('well') * 0.6),
      shrineDeficit: clamp(0.5 - near('shrine') * 0.5),
      wallDeficit: clamp(0.3 - near('wall') * 0.3),
      hallDeficit: clamp(0.25 - near('hall') * 0.5),
      bridgeDeficit: clamp(0.4 - near('bridge') * 0.5),
      pathDeficit: clamp(0.5 - near('path') * 0.2),
      plazaDeficit: clamp(0.35 - near('plaza') * 0.5),
    };
  }

  bestBuildMaterial(a, fn) {
    let best = null;
    for (const [k, v] of a.inventory) {
      if (v < 1) continue;
      const c = this.ont.get(k);
      if (!c) continue;
      const score = c.serves(fn) || c.props.hard * 0.4 || c.props.flexible * 0.3;
      if (score > (best?.score || 0.05)) best = { key: k, score };
    }
    return best;
  }

  pickBuildSite(a, kind, settlement) {
    const s = settlement || this.nearestSettlement(a.x, a.y);
    for (let i = 0; i < 30; i++) {
      const x = clamp(s.x + this.rng.int(-6, 6), 1, this.world.w - 2);
      const y = clamp(s.y + this.rng.int(-6, 6), 1, this.world.h - 2);
      if (!this.world.walkable(x, y)) continue;
      if (this.world.structuresAt?.(x, y)?.length) continue;
      if (kind === 'bridge') {
        let nearW = false;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t = this.world.at(x + ox, y + oy);
          if (t === TERRAIN.WATER || t === TERRAIN.MARSH) nearW = true;
        }
        if (!nearW) continue;
      }
      return { x, y };
    }
    return { x: a.x, y: a.y };
  }

  foundSettlement(a, spot) {
    const name = this.lang.placeName(this.rng);
    this.registerLex(name, 'settlement', 'place');
    const settlement = {
      kind: 'settlement', name, x: spot.x, y: spot.y,
      foundedTick: this.world.tick, color: hueFor(this.settlements.length), tier: 'camp',
    };
    this.settlements.push(settlement);
    this.world.sites.push(settlement);
    this.record(a, 'first', `${a.name} broke off from the rest and raised ${name} on new ground`, {
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
      recentEpisodes: a.memory.recall(() => true, 8).map((m) => ({
        kind: m.kind, text: m.text,
        salience: +m.salience.toFixed(2), valence: +m.valence.toFixed(2), tick: m.tick,
      })),
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
