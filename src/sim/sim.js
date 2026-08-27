// The society layer: who knows whom, who owes whom, what is held to be wrong,
// who is buried where, and what the whole thing adds up to.
//
// Norms are not decrees. They are statistical shadows of what minds have learned.
// Language is native-first; plain + gloss layers exist so an observer can follow.

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
  conceptionChance: 0.032,
  pregnancyTerm: 0.7,
  birthHealthCost: 0.12,
  grievanceInterval: 6,
  normsInterval: 24,
  spoilInterval: 24,
  rolesInterval: 12,
  chronicleInterval: 24,
  tiersInterval: 24,
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

// Growth is shown, not scripted: a settlement's tier is just a read-out of how
// much is actually there. Nothing caps this list from growing further — it's
// just the ranks named so far.
const SETTLEMENT_TIERS = [
  { min: 0, name: 'camp' },
  { min: 6, name: 'hamlet' },
  { min: 16, name: 'village' },
  { min: 32, name: 'town' },
  { min: 60, name: 'city' },
];
function article(word) { return /^[aeiou]/i.test(word) ? 'an' : 'a'; }

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

    for (let i = 0; i < n; i++) {
      let x = cx, y = cy, tries = 0;
      do {
        x = clamp(cx + rng.int(-4, 4), 1, world.w - 2);
        y = clamp(cy + rng.int(-4, 4), 1, world.h - 2);
        tries++;
      } while (!world.walkable(x, y) && tries < 40);

      const g = randomGenome(rng);
      const personName = this.lang.personName(rng);
      this.registerLex(personName, 'founder', 'person');

      const a = new Agent({
        name: personName, genome: g, x, y, tick: 0, world, culture: this.lang.name,
      });
      a.bornTick = -rng.int(16, 34) * YEAR_TICKS;

      for (const c of this.ont.all()) {
        if (c.kind !== 'matter') continue;
        if (rng.bool(0.35 + g.curiosity * 0.3)) {
          a.memory.learn(c.key, {
            kind: 'matter', confidence: rng.float(0.3, 0.7), valence: 0.2, source: 'upbringing',
          });
        }
      }
      for (const food of ['berry', 'root', 'grain']) {
        a.memory.learn(food, {
          kind: 'matter', confidence: rng.float(0.5, 0.9), valence: 0.4, source: 'upbringing',
        });
      }
      for (const seed of NORM_SEEDS) {
        if (rng.bool(0.55 + g.empathy * 0.25)) {
          a.memory.learn(`norm:${seed.key}`, {
            kind: 'norm',
            confidence: rng.float(0.2, 0.45),
            valence: seed.polarity > 0 ? 0.4 : -0.45,
            source: 'upbringing',
            payload: { situation: seed.key, polarity: seed.polarity, label: seed.label, evidence: 1 },
          });
        }
      }
      a.add('water', 1);
      a.add(rng.pick(['berry', 'root']), rng.int(1, 3));
      this.addAgent(a);
    }
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
    if (w.tick % BALANCE.tiersInterval === 0) this.updateSettlementTiers();
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
        const left = v * (1 - 0.02 * (1 - keeps));
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
    const strongMem = a.memory.recall((m) => m.salience > 0.5, 3)[0];
    if (strongMem) options.push({ type: 'memory', memory: strongMem, valence: strongMem.valence });

    const rels = [...a.relationships.values()].filter(
      (r) => r.id !== o.id && Math.abs(r.affection) > 0.25 && this.byId(r.id)?.alive,
    );
    if (rels.length && a.genome.sociability > 0.4) {
      const r = rng.pick(rels);
      options.push({ type: 'gossip', gossipAbout: r.id, valence: r.affection, transfer: null });
    }
    if (a.affect.e.grief > 0.3) options.push({ type: 'grief', valence: -0.6 });
    if (a.affect.e.awe > 0.3) options.push({ type: 'awe', valence: 0.5 });
    if (a.body.hunger > 0.6) options.push({ type: 'hunger', valence: -0.4 });

    if (!options.length) return null;
    return rng.pick(options);
  }

  utterance(a, o, topic) {
    const W = (k) => this.ont.get(k)?.word || this.lang.word(k);
    switch (topic.type) {
      case 'place': {
        const key = topic.key.replace('where:', '');
        const b = a.memory.belief(topic.key);
        const p = b?.payload;
        return `${o.name}. ${W(key)} — ${
          p
            ? `${p.x > a.x ? 'east' : 'west'} of here, ${p.y > a.y ? 'downstream' : 'upstream'}`
            : 'I have seen it somewhere'
        }.`;
      }
      case 'recipe':
        return `${o.name}, listen. ${W(topic.key)} — it is made, not found. I will show you.`;
      case 'matter':
        return `There is ${W(topic.key)} in this country. I did not know that either, once.`;
      case 'norm': {
        const b = a.memory.belief(topic.key);
        const label = b?.payload?.label || topic.key.replace(/^norm:/, '');
        return (b?.valence ?? 0) < 0
          ? `${o.name}, this is not to be done — ${label}. I have seen what follows.`
          : `${o.name}, this is how we hold together — ${label}.`;
      }
      case 'memory':
        return `I still think of it. ${topic.memory.text}.`;
      case 'gossip': {
        const s = this.byId(topic.gossipAbout);
        const r = a.rel(s);
        return r.affection > 0
          ? `${s.name} is sound. ${r.debt > 0 ? 'I owe them.' : 'I would stand beside them.'}`
          : `Be careful with ${s.name}. ${r.conflicts ? 'We have had words.' : 'Something is not right there.'}`;
      }
      case 'grief': return `I keep turning to speak and there is no one there.`;
      case 'awe': return `Does it not strike you — that any of this holds together at all?`;
      case 'hunger':
        return `${o.name}, I have not eaten. Is there anything in the ${
          this.world.structuresOfKind('store')[0]?.word || 'stores'
        }?`;
      default: return `${o.name}.`;
    }
  }

  voiceThought(a, act) {
    const lines = {
      experiment: [`If I put these together... something must come of it.`, `No one has tried this. That is reason enough.`],
      gather: [`Enough of this and we last the week.`, `Hands first. Thinking after.`],
      hunt: [`Quiet now.`, `We eat tonight or we do not.`],
      build: [`It should stand longer than I will.`, `Straight. It has to be straight.`],
      expand: [`This ground is too crowded for what we are becoming.`, `There is room past here. I mean to see it settled.`],
      teach: [`It dies with me otherwise.`],
      ritual: [`Say the words. Say them properly.`],
      makeArt: [`There. That is what it felt like.`],
      explore: [`What is past that ridge?`],
      steal: [`I am not proud. I am hungry.`],
      fight: [`Enough.`],
      sleep: [`Enough for today.`],
    };
    const pool = lines[act.kind];
    if (!pool) return;
    const text = this.rng.pick(pool);
    a.say(text, 'thought');
    this.record(a, 'thought', text, {
      actors: [a.id], intensity: 0.2, valence: a.affect.valence * 0.3, voice: a.name, quiet: false,
    });
  }

  teach(a, o, key) {
    const b = a.memory.belief(key);
    if (!b) return;
    const gain = (0.3 + a.skills.teach * 0.6) * o.genome.learning;
    o.memory.learn(key, {
      kind: b.kind, confidence: gain, valence: b.valence,
      source: `taught by ${a.name}`, payload: b.payload,
    });
    for (const e of a.memory.related(key)) o.memory.link(key, e.rel, e.key, e.weight * 0.6);
    a.gainSkill('teach', 0.05);
    o.gainSkill('craft', 0.02);
    a.stats.taught++;
    o.stats.learned++;
    this.counters.lessons++;
    o.adjustRel(a, { respect: 0.14, trust: 0.1, familiarity: 0.06 });
    a.adjustRel(o, { affection: 0.06, familiarity: 0.06 });
    const word = this.ont.get(key)?.word || key;
    this.record(a, 'teach', `${a.name} taught ${o.name} how ${word} is made`, {
      actors: [a.id, o.id], valence: 0.55, intensity: 0.55, concept: key,
    });
    appraise(a, { goalCongruence: 0.5, agency: 'self', intensity: 0.5, kind: 'teach', norm: 1, social: o.id });
    appraise(o, { goalCongruence: 0.6, agency: 'other', intensity: 0.6, kind: 'teach', novelty: 0.6, social: a.id });
    this.upholdNorm('teaching', 0.02);
    this.reputationDelta(a, 0.03);
  }

  findDeal(a, o) {
    let bestGive = null, bestGet = null;
    for (const [k, v] of a.inventory) {
      if (v < 1) continue;
      const mine = a.desireFor(k, this.ont, this);
      if (!bestGive || mine < bestGive.value) bestGive = { key: k, value: mine };
    }
    for (const [k, v] of o.inventory) {
      if (v < 1) continue;
      const want = a.desireFor(k, this.ont, this);
      if (!bestGet || want > bestGet.value) bestGet = { key: k, value: want };
    }
    if (!bestGive || !bestGet || bestGive.key === bestGet.key) return null;
    const myGain = bestGet.value - bestGive.value;
    const theirGain = o.desireFor(bestGive.key, this.ont, this) - o.desireFor(bestGet.key, this.ont, this);
    if (myGain <= 0.05 || theirGain <= 0.02) return null;
    return { give: bestGive.key, get: bestGet.key, gain: myGain, theirGain };
  }

  settleTrade(a, o, deal) {
    a.rel(o).lastTrade = this.world.tick;
    o.rel(a).lastTrade = this.world.tick;
    if (!a.take(deal.give, 1)) return;
    if (!o.take(deal.get, 1)) { a.add(deal.give, 1); return; }
    o.add(deal.give, 1);
    a.add(deal.get, 1);
    a.stats.trades++;
    o.stats.trades++;
    this.counters.trades++;
    a.gainSkill('trade', 0.03);
    o.gainSkill('trade', 0.03);
    a.rel(o).exchanges++;
    o.rel(a).exchanges++;
    a.adjustRel(o, { trust: 0.07, familiarity: 0.05 });
    o.adjustRel(a, { trust: 0.07, familiarity: 0.05 });
    a.updateValue(deal.get, a.valueOf(deal.get, this.ont) * 0.96);
    o.updateValue(deal.give, o.valueOf(deal.give, this.ont) * 0.96);
    for (const key of [deal.give, deal.get]) {
      const believed = mean(this.living, (x) => x.valueOf(key, this.ont));
      const m = this.marketPrices.get(key) || { price: believed, volume: 0 };
      m.price = m.price * 0.8 + believed * 0.2;
      m.volume++;
      this.marketPrices.set(key, m);
      this.chronicle.notePrice(key, m.price, this.world.tick);
    }
    const gw = this.ont.get(deal.give)?.word;
    const tw = this.ont.get(deal.get)?.word;
    this.record(a, 'trade', `${a.name} traded ${gw} to ${o.name} for ${tw}`, {
      actors: [a.id, o.id], valence: 0.4, intensity: 0.4,
    });
    appraise(a, { goalCongruence: clamp(deal.gain, 0, 1), agency: 'self', intensity: 0.4, kind: 'trade', social: o.id });
    appraise(o, { goalCongruence: clamp(deal.theirGain, 0, 1), agency: 'other', intensity: 0.4, kind: 'trade', social: a.id });
  }

  onTheft(a, o, key, n) {
    this.counters.thefts++;
    const word = this.ont.get(key)?.word || key;
    o.adjustRel(a, { trust: -0.5, affection: -0.4, respect: -0.2 });
    o.rel(a).conflicts++;
    this.record(a, 'theft', `${a.name} took ${Math.round(n * 10) / 10} ${word} from ${o.name}`, {
      actors: [a.id, o.id], valence: -0.7, intensity: 0.75, landmark: true,
    });
    appraise(a, {
      goalCongruence: 0.4, agency: 'self', intensity: 0.6,
      norm: this.personalNorm(a, 'theft'), kind: 'betrayal', social: o.id,
    });
    appraise(o, {
      goalCongruence: -0.7, agency: 'other', intensity: 0.8, norm: -1, kind: 'betrayal', social: a.id,
    });
    a.memory.learn('norm:theft', {
      kind: 'norm', confidence: 0.25, valence: -0.35, source: 'experience',
      payload: { situation: 'theft', polarity: -1, evidence: 1 },
    });
    o.memory.learn('norm:theft', {
      kind: 'norm', confidence: 0.45, valence: -0.75, source: 'suffering',
      payload: { situation: 'theft', polarity: -1, evidence: 1 },
    });
    this.violateNorm('theft', 0.05);
    this.reputationDelta(a, -0.09);
    for (const w of this.nearby(a, 6)) {
      if (w === a || w === o) continue;
      w.adjustRel(a, { trust: -0.2, respect: -0.1, affection: -0.15 });
      w.memory.learn('norm:theft', {
        kind: 'norm', confidence: 0.2, valence: -0.5, source: 'witness',
        payload: { situation: 'theft', polarity: -1, evidence: 1 },
      });
      appraise(w, {
        goalCongruence: -0.2, agency: 'other', intensity: 0.4, norm: -1, kind: 'witness', social: a.id,
      });
    }
  }

  resolveFight(a, o) {
    this.counters.conflicts++;
    a.lastFightTick = this.world.tick;
    o.lastFightTick = this.world.tick;
    a.affect.e.anger = clamp(a.affect.e.anger * 0.25);
    o.affect.e.anger = clamp(o.affect.e.anger * 0.5);

    const power = (x) =>
      0.2 +
      x.skills.fight * 0.7 +
      x.body.energy * 0.4 +
      x.genome.aggression * 0.3 +
      (x.bestToolFor('weapon', this.ont)?.score || 0);

    const pa = power(a);
    const po = power(o);
    const aWins = this.rng.next() < pa / (pa + po);
    const winner = aWins ? a : o;
    const loser = aWins ? o : a;
    const harm = clamp(0.08 + this.rng.float(0, 0.22) * (winner === a ? pa : po), 0, 0.55);
    loser.body.injury = clamp(loser.body.injury + harm, 0, 1);
    winner.gainSkill('fight', 0.06);
    a.stats.fights++;
    o.stats.fights++;
    a.rel(o).conflicts++;
    o.rel(a).conflicts++;
    a.adjustRel(o, { affection: -0.3, trust: -0.25 });
    o.adjustRel(a, { affection: -0.3, trust: -0.25 });
    winner.adjustRel(loser, { respect: -0.1 });
    loser.adjustRel(winner, { respect: 0.06 });

    this.record(
      a, 'violence',
      `${a.name} and ${o.name} came to blows — ${winner.name} stood, ${loser.name} did not`,
      { actors: [a.id, o.id], valence: -0.8, intensity: 0.85, landmark: true },
    );
    appraise(loser, {
      goalCongruence: -0.8, agency: 'other', intensity: 0.85, kind: 'violence', norm: -1, social: winner.id,
    });
    appraise(winner, {
      goalCongruence: 0.2, agency: 'self', intensity: 0.7, kind: 'violence',
      norm: this.personalNorm(winner, 'violence'), social: loser.id,
    });
    for (const person of [a, o]) {
      person.memory.learn('norm:violence', {
        kind: 'norm', confidence: 0.3, valence: -0.6, source: 'experience',
        payload: { situation: 'violence', polarity: -1, evidence: 1 },
      });
    }
    this.violateNorm('violence', 0.06);
    this.reputationDelta(winner, -0.05);
    for (const w of this.nearby(a, 7)) {
      if (w === a || w === o) continue;
      appraise(w, { goalCongruence: -0.3, agency: 'other', intensity: 0.5, norm: -1, kind: 'witness' });
      w.adjustRel(winner, { trust: -0.12 });
      w.memory.learn('norm:violence', {
        kind: 'norm', confidence: 0.2, valence: -0.55, source: 'witness',
        payload: { situation: 'violence', polarity: -1, evidence: 1 },
      });
    }
  }

  tryBond(a, o) {
    const r = a.rel(o);
    const r2 = o.rel(a);
    if (r.affection < 0.28 || r2.affection < 0.24) return;

    a.partner = o.id;
    o.partner = a.id;
    const household = {
      id: `h${this.households.length + 1}`,
      members: [a.id, o.id],
      foundedTick: this.world.tick,
      home: a.home || o.home,
    };
    this.households.push(household);
    a.household = household.id;
    o.household = household.id;

    this.record(a, 'bond', `${a.name} and ${o.name} bound themselves to one another`, {
      actors: [a.id, o.id], valence: 0.9, intensity: 0.9, landmark: true,
    });
    appraise(a, { goalCongruence: 0.9, agency: 'self', intensity: 0.9, kind: 'bond', social: o.id });
    appraise(o, { goalCongruence: 0.9, agency: 'self', intensity: 0.9, kind: 'bond', social: a.id });
    a.adjustRel(o, { affection: 0.4, trust: 0.3, kin: 0.8 });
    o.adjustRel(a, { affection: 0.4, trust: 0.3, kin: 0.8 });
    this.ritualPull = clamp(this.ritualPull + 0.3, 0, 2);

    for (const riv of this.living) {
      if (riv === a || riv === o) continue;
      const target = riv.lastCourtTarget;
      if (!target || this.world.tick - target.tick > 200) continue;
      if (target.id !== a.id && target.id !== o.id) continue;
      const other = target.id === a.id ? a : o;
      appraise(riv, {
        goalCongruence: -0.5, agency: 'other',
        intensity: 0.5 + riv.genome.aggression * 0.2, kind: 'spurned', social: other.id,
      });
      riv.adjustRel(other, { affection: -0.15, trust: -0.1 });
    }
  }

  lifecycleTick() {
    const w = this.world;
    for (const a of this.living) {
      if (
        !a.body.pregnant &&
        a.partner &&
        a.ageAt(w.tick) > 16 &&
        a.ageAt(w.tick) < 45
      ) {
        const p = this.byId(a.partner);
        if (
          p && p.alive && !p.body.pregnant &&
          dist(a, p) < 7 &&
          a.body.health > 0.55 && a.body.hunger < 0.78 &&
          p.body.health > 0.55 && p.body.hunger < 0.78 &&
          a.id < p.id &&
          this.rng.bool(
            BALANCE.conceptionChance * ((a.genome.fertility + p.genome.fertility) / 2),
          )
        ) {
          const aChance = a.genome.fertility / Math.max(0.01, a.genome.fertility + p.genome.fertility);
          const carrier = this.rng.next() < aChance ? a : p;
          const other = carrier === a ? p : a;
          carrier.body.pregnant = { since: w.tick, otherId: other.id };
        }
      }
      if (a.body.pregnant) {
        const term = BALANCE.pregnancyTerm * YEAR_TICKS;
        a.body.hunger = clamp(a.body.hunger + 0.004, 0, 1);
        if (w.tick - a.body.pregnant.since > term) this.birth(a);
      }
    }
  }

  birth(mother) {
    const father = this.byId(mother.body.pregnant.otherId);
    mother.body.pregnant = null;
    if (mother.body.health < 0.25) return;

    const g = father ? inherit(this.rng, mother.genome, father.genome) : randomGenome(this.rng);
    const childName = this.lang.personName(this.rng);
    this.registerLex(childName, `child of ${mother.name}`, 'person');

    const child = new Agent({
      name: childName, genome: g, x: mother.x, y: mother.y,
      tick: this.world.tick,
      parents: [mother.id, father?.id].filter(Boolean),
      world: this.world, culture: this.lang.name,
    });
    child.home = mother.home;
    this.addAgent(child);

    for (const parent of [mother, father].filter(Boolean)) {
      for (const b of parent.memory.semantic.values()) {
        if (b.kind !== 'norm' || b.confidence < 0.25) continue;
        if (this.rng.bool(0.4 + child.genome.learning * 0.3)) {
          child.memory.learn(b.key, {
            kind: 'norm', confidence: b.confidence * 0.35, valence: b.valence * 0.8,
            source: `upbringing:${parent.name}`, payload: b.payload,
          });
        }
      }
    }

    mother.children.push(child.id);
    if (father) father.children.push(child.id);
    mother.stats.births++;
    this.counters.births++;
    mother.body.health = clamp(mother.body.health - BALANCE.birthHealthCost, 0, 1);

    for (const p of [mother, father].filter(Boolean)) {
      p.adjustRel(child, { affection: 0.7, trust: 0.6, kin: 1, familiarity: 0.4 });
      child.adjustRel(p, { affection: 0.6, trust: 0.7, kin: 1, familiarity: 0.4 });
      appraise(p, { goalCongruence: 0.95, agency: 'self', intensity: 0.95, kind: 'birth', social: child.id });
    }
    for (const sibId of mother.children) {
      const s = this.byId(sibId);
      if (s && s !== child) {
        s.adjustRel(child, { kin: 0.8, affection: 0.3 });
        child.adjustRel(s, { kin: 0.8, affection: 0.3 });
      }
    }
    this.record(
      mother, 'birth',
      `${child.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''}`,
      {
        actors: [mother.id, child.id].concat(father ? [father.id] : []),
        valence: 0.9, intensity: 0.9, landmark: true,
      },
    );
    this.ritualPull = clamp(this.ritualPull + 0.2, 0, 2);
    return child;
  }

  die(a, cause) {
    if (!a.alive) return;
    a.alive = false;
    a.deathCause = cause;
    a.deathTick = this.world.tick;
    a.action = null;
    this.livingCache = null;
    this.counters.deaths++;
    this.chronicle.noteCause(cause);

    const age = a.ageAt(a.deathTick).toFixed(0);
    this.record(a, 'death', `${a.name} died of ${cause} at ${age}`, {
      actors: [a.id], valence: -0.9, intensity: 1, landmark: true,
    });

    if (a.partner) {
      const p = this.byId(a.partner);
      if (p) {
        p.partner = null;
        appraise(p, { goalCongruence: -1, agency: 'world', intensity: 1, kind: 'death', social: a.id });
      }
    }

    let mourners = 0;
    for (const o of this.living) {
      const r = o.relationships.get(a.id);
      if (!r) continue;
      const closeness = r.affection * 0.5 + r.kin * 0.7 + r.familiarity * 0.4 + r.trust * 0.3;
      if (closeness < 0.15) continue;
      mourners++;
      appraise(o, {
        goalCongruence: -clamp(closeness), agency: 'world', intensity: clamp(closeness),
        kind: 'death', social: a.id,
      });
      o.memory.remember({
        tick: this.world.tick, kind: 'death', text: `${a.name} died of ${cause}`,
        actors: [a.id, o.id], valence: -0.9, intensity: clamp(closeness),
      });
    }
    a.mourners = mourners;
    this.ritualPull = clamp(this.ritualPull + 0.25 + mourners * 0.05, 0, 2);

    const heirs = a.children.map((id) => this.byId(id)).filter((c) => c && c.alive);
    if (heirs.length) {
      for (const [k, v] of a.inventory) {
        const base = Math.floor(v / heirs.length);
        let remainder = v - base * heirs.length;
        for (const h of heirs) {
          const share = base + (remainder > 0 ? 1 : 0);
          if (share > 0) h.add(k, share);
          if (remainder > 0) remainder--;
        }
      }
      this.record(a, 'inherit', `${heirs.map((h) => h.name).join(' and ')} took what ${a.name} left`, {
        actors: heirs.map((h) => h.id), valence: 0.1, intensity: 0.4,
      });
    }
    a.inventory.clear();

    for (const key of a.memory.knownKeys('recipe')) {
      const stillKnown = this.living.some((o) => o.memory.knows(key, 0.25));
      if (!stillKnown) {
        const c = this.ont.get(key);
        this.lostKnowledge.push({
          key, word: c?.word || key, tick: this.world.tick, lastKeeper: a.name, fn: c?.bestFn,
        });
        if (this.lostKnowledge.length > BALANCE.maxLostKnowledge) {
          this.lostKnowledge.splice(0, this.lostKnowledge.length - BALANCE.maxLostKnowledge);
        }
        this.record(a, 'loss', `How to make ${c?.word || key} was lost — ${a.name} was the last who knew`, {
          actors: [a.id], valence: -0.7, intensity: 0.8, landmark: true, concept: key,
        });
      }
    }

    this.world.corpses.push({
      id: a.id, name: a.name, x: a.x, y: a.y, tick: this.world.tick, cause,
    });
  }

  bury(a, corpse) {
    const i = this.world.corpses.indexOf(corpse);
    if (i >= 0) this.world.corpses.splice(i, 1);
    const dead = this.byId(corpse.id);
    if (dead) dead.buried = true;

    let field = this.world.sites.find((s) => s.kind === 'graves');
    if (!field) {
      const fieldName = `${this.lang.coinRaw(2)} Field`;
      this.registerLex(fieldName, 'first burial ground', 'place');
      field = {
        kind: 'graves', name: fieldName, x: corpse.x, y: corpse.y,
        foundedTick: this.world.tick, graves: 0,
      };
      this.world.sites.push(field);
      this.record(a, 'first', `${a.name} opened ${field.name}, the first ground given to the dead`, {
        valence: -0.2, intensity: 0.8, landmark: true,
      });
    }
    field.graves = (field.graves || 0) + 1;
    a.stats.buried++;
    a.memory.learn('norm:burial', {
      kind: 'norm', confidence: 0.35, valence: 0.55, source: 'experience',
      payload: { situation: 'burial', polarity: 1, evidence: 1 },
    });
    this.upholdNorm('burial', 0.05);
    this.record(a, 'ritual', `${a.name} buried ${corpse.name} in ${field.name}`, {
      actors: [a.id, corpse.id], valence: -0.3, intensity: 0.7, landmark: true,
    });
    appraise(a, { goalCongruence: 0.3, agency: 'self', intensity: 0.6, norm: 1, kind: 'ritual' });
    a.affect.e.grief = clamp(a.affect.e.grief * 0.7);
    this.reputationDelta(a, 0.03);
  }

  performRitual(a, site) {
    this.counters.rituals++;
    a.affect.e.grief = clamp(a.affect.e.grief * 0.75);
    a.affect.e.awe = clamp(a.affect.e.awe + 0.15);
    a.affect.mood = clamp(a.affect.mood + 0.06, -1, 1);
    const attendees = this.nearby(a, 4);
    for (const o of attendees) {
      o.affect.mood = clamp(o.affect.mood + 0.03, -1, 1);
      o.adjustRel(a, { familiarity: 0.03, respect: 0.03 });
    }
    let rit = this.rituals.find((r) => r.site === (site.name || site.word));
    if (!rit) {
      const ritName = `the ${this.lang.coinRaw(2)}`;
      this.registerLex(ritName, 'named ritual practice', 'ritual');
      rit = {
        name: ritName, site: site.name || site.word,
        foundedTick: this.world.tick, observances: 0, founder: a.name,
      };
      this.rituals.push(rit);
      if (this.rituals.length > BALANCE.maxRituals) {
        this.rituals.splice(0, this.rituals.length - BALANCE.maxRituals);
      }
      this.record(a, 'ritual', `${a.name} began ${rit.name} at ${rit.site}`, {
        valence: 0.4, intensity: 0.8, landmark: true,
      });
    }
    rit.observances++;
    if (rit.observances === 12) {
      const belief = {
        text: `that ${rit.name} keeps the dead from being nothing`,
        since: this.world.tick, holders: attendees.length + 1,
      };
      this.beliefs.push(belief);
      if (this.beliefs.length > BALANCE.maxBeliefs) {
        this.beliefs.splice(0, this.beliefs.length - BALANCE.maxBeliefs);
      }
      this.record(a, 'belief', `They began to hold ${belief.text}`, {
        valence: 0.3, intensity: 0.8, landmark: true,
      });
    }
  }

  makeArt(a, mediumKey) {
    this.counters.artworks++;
    const subject = a.memory.recall((m) => m.salience > 0.45, 1)[0];
    const name = this.lang.coinRaw(2);
    this.registerLex(name, 'artwork', 'concept');
    const work = {
      name, by: a.name, tick: this.world.tick,
      medium: mediumKey ? this.ont.get(mediumKey)?.word : 'earth and hands',
      about: subject ? subject.text : 'the look of the country in this season',
      emotion: dominantEmotion(a),
    };
    this.artworks.push(work);
    if (this.artworks.length > BALANCE.maxArtworks) {
      this.artworks.splice(0, this.artworks.length - BALANCE.maxArtworks);
    }
    a.affect.mood = clamp(a.affect.mood + 0.08, -1, 1);
    a.affect.e.grief = clamp(a.affect.e.grief * 0.85);
    if (!a.titles.includes('maker of images') && a.stats.crafted > 3 && a.skills.art > 0.4) {
      a.titles.push('maker of images');
    }
    this.record(
      a, 'art',
      `${a.name} made ${name}, ${
        work.medium === 'earth and hands' ? 'from earth and hands' : `in ${work.medium}`
      } — about ${work.about}`,
      { valence: 0.5, intensity: 0.6, landmark: true },
    );
    appraise(a, { goalCongruence: 0.6, agency: 'self', intensity: 0.6, kind: 'first', novelty: 0.5 });
    if (mediumKey) a.take(mediumKey, 0.5);
  }

  onInvention(a, record, concept) {
    this.inventionTicks.set(record.key, this.world.tick);
    if (concept?.word) {
      this.registerLex(
        concept.word,
        record.advance ? `new ${record.fn}` : `variant ${record.fn}`,
        'concept',
      );
    }
    const fnWord = record.fn;
    const text = record.advance
      ? `${a.name} made ${concept.word} — nothing they had served ${fnWord} so well`
      : `${a.name} made ${concept.word}, a ${fnWord} of sorts, no better than what they had`;
    this.record(a, 'invention', text, {
      valence: record.advance ? 0.9 : 0.3,
      intensity: record.advance ? 0.95 : 0.4,
      landmark: record.advance,
      concept: concept.key,
      advance: record.advance,
      quiet: !record.advance && !this.rng.bool(0.12),
    });
    if (record.advance) {
      if (!a.titles.includes('maker')) a.titles.push('maker');
      this.reputationDelta(a, 0.08);
      a.memory.learn('norm:craft', {
        kind: 'norm', confidence: 0.3, valence: 0.5, source: 'experience',
        payload: { situation: 'craft', polarity: 1, evidence: 1 },
      });
      for (const o of this.nearby(a, 8)) {
        o.adjustRel(a, { respect: 0.12 });
        appraise(o, {
          goalCongruence: 0.3, agency: 'other', intensity: 0.5, novelty: 0.9, kind: 'witness', social: a.id,
        });
        if (this.rng.bool(0.4 * o.genome.learning)) {
          o.memory.learn(concept.key, {
            kind: 'recipe', confidence: 0.3, valence: 0.5, source: `watched ${a.name}`,
          });
          o.stats.learned++;
        }
      }
      this.upholdNorm('craft', 0.03);
    }
  }

  nearestSettlement(x, y) {
    let best = this.settlements[0], bd = Infinity;
    for (const s of this.settlements) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  settlementPressure(settlement, radius = 22) {
    const pop = this.living.filter((a) => dist(a, settlement) < radius).length;
    return clamp((pop - 16) / 12, 0, 1);
  }

  /** How grown each settlement is, expressed the same way to everyone: a tier
   *  name, derived fresh each time from living population and structures built
   *  nearby — never assigned directly, so it can only ever reflect what's
   *  actually there. */
  updateSettlementTiers() {
    for (const s of this.settlements) {
      const pop = this.living.filter((a) => dist(a, s) < 22).length;
      const built = this.world.structures.filter((st) => dist(st, s) < 22).length;
      const score = pop + built * 0.5;
      let tier = SETTLEMENT_TIERS[0].name, rank = 0;
      SETTLEMENT_TIERS.forEach((t, i) => { if (score >= t.min) { tier = t.name; rank = i; } });
      if (tier !== s.tier) {
        const priorRank = SETTLEMENT_TIERS.findIndex((t) => t.name === s.tier);
        const grew = rank > priorRank;
        s.tier = tier;
        this.record(null, grew ? 'growth' : 'decline', `${s.name} became ${article(tier)} ${tier}`, {
          valence: grew ? 0.4 : -0.3, intensity: 0.6, landmark: true,
        });
      }
    }
  }

  updateWants() {
    const want = new Map();
    for (const settlement of this.settlements) {
      const s = this.settlementNeeds(settlement);
      for (const [kind, def] of Object.entries(STRUCTURE_KINDS)) {
        const need = def.need(s);
        if (need <= 0.05) continue;
        let bk = null, bs = 0;
        for (const c of this.ont.all()) {
          if (c.kind !== 'matter') continue;
          const sc = Math.max(c.serves(def.fn), c.props.durable * 0.5 + c.props.hard * 0.4);
          if (sc > bs) { bs = sc; bk = c.key; }
        }
        if (bk) want.set(bk, Math.max(want.get(bk) || 0, need));
      }
    }
    this.wantedMaterials = want;
  }

  settlementNeeds(settlement, radius = 22) {
    const w = this.world;
    const pop = Math.max(1, this.living.filter((a) => dist(a, settlement) < radius).length);
    const count = (k) => w.structuresOfKind(k).filter((s) => dist(s, settlement) < radius).length;
    const need = (have, per) => clamp((pop / per - have) / Math.max(1, pop / per));
    return {
      shelterDeficit: need(count('shelter'), 2.2),
      hearthDeficit: need(count('hearth'), 6) * (w.temperature < 0.5 ? 1.6 : 0.7),
      storeDeficit: need(count('store'), 10) * (w.season === 'autumn' ? 1.7 : 1),
      workshopDeficit: need(count('workshop'), 8) * (this.ont.bestScoreFor('cutting') > 0.2 ? 1.4 : 0.4),
      fieldDeficit: need(count('field'), 5) * (this.ont.bestScoreFor('cutting') > 0.25 ? 1.3 : 0.3),
      wellDeficit: need(count('well'), 14) * (this.ont.bestScoreFor('vessel') > 0.3 ? 1.2 : 0.2),
      shrineDeficit: need(count('shrine'), 16) * clamp(this.ritualPull),
      wallDeficit: need(count('wall'), 26) * clamp(mean(this.living, (x) => x.affect.e.fear) * 2),
      hallDeficit: pop > 18 && count('hall') < 1 ? 0.9 : 0,
    };
  }

  bestBuildMaterial(a, fn) {
    let best = null;
    for (const key of a.inventory.keys()) {
      const c = this.ont.get(key);
      if (!c) continue;
      const score = Math.max(c.serves(fn), c.props.durable * 0.5 + c.props.hard * 0.4);
      if (score < 0.12) continue;
      if (!best || score > best.score) best = { key, score };
    }
    return best;
  }

  pickBuildSite(a, kind, settlement = this.nearestSettlement(a.x, a.y)) {
    const w = this.world;
    const anchor = kind === 'field'
      ? topN(
          [...Array(40)].map(() => ({
            x: clamp(settlement.x + this.rng.int(-10, 10), 1, w.w - 2),
            y: clamp(settlement.y + this.rng.int(-10, 10), 1, w.h - 2),
          })),
          1,
          (p) => (w.walkable(p.x, p.y) ? w.fertility[w.idx(p.x, p.y)] : -1),
        )[0]
      : settlement;
    for (let r = 1; r < 16; r++) {
      for (let i = 0; i < 14; i++) {
        const x = clamp(anchor.x + this.rng.int(-r, r), 1, w.w - 2);
        const y = clamp(anchor.y + this.rng.int(-r, r), 1, w.h - 2);
        if (!w.walkable(x, y) || w.structureAt(x, y)) continue;
        return { x, y };
      }
    }
    return null;
  }

  foundSettlement(a, spot) {
    const name = this.lang.placeName(this.rng);
    this.registerLex(name, `settlement founded by ${a.name}`, 'place');
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
    for (const c of [...this.world.corpses]) {
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

  spawnOrStrengthenNorm(key, label, polarity, weight) {
    const sample = this.living[0];
    if (sample) {
      sample.memory.learn(`norm:${key}`, {
        kind: 'norm', confidence: 0.15 + weight,
        valence: polarity > 0 ? 0.4 : -0.4, source: 'reflection',
        payload: { situation: key, polarity, label, evidence: 1 },
      });
    }
    return this.norms.find((x) => x.key === key) || null;
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

  dailyReflection() {
    for (const a of this.living) {
      if (this.rng.bool(0.3)) a.memory.consolidate(a);
      for (const [k] of a.inventory) {
        const m = this.marketPrices.get(k);
        if (m) a.updateValue(k, m.price, 0.08);
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
      for (const v of s.stock.values()) t += v;
    }
    return Math.round(t);
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

export { YEAR_TICKS, SKILLS, moodWord, BALANCE, NORM_SEEDS, SETTLEMENT_TIERS };
