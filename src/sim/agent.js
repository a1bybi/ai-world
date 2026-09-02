import { clamp } from '../core/util.js';
import { blankAffect } from './emotion.js';
import { MemoryStore } from './memory.js';
import { dominantTraits } from './genome.js';

export const YEAR_TICKS = 24 * 30;   // a year is thirty days here, so lineages actually turn over

export const SKILLS = ['forage', 'hunt', 'craft', 'build', 'farm', 'speak', 'teach', 'fight', 'heal', 'trade', 'art'];

let seq = 0;

export class Agent {
  // Support two call styles for backward compatibility:
  // 1) new Agent(sim, opts)  -- used by src/sim/sim.js
  // 2) new Agent(opts)       -- direct creation with destructured opts
  constructor(simOrOpts = {}, maybeOpts = undefined) {
    let sim = null;
    let opts = {};
    if (maybeOpts !== undefined) {
      sim = simOrOpts;
      opts = maybeOpts || {};
    } else {
      opts = simOrOpts || {};
    }

    this.sim = sim;
    this.world = this.sim?.world || opts.world || null;

    // establish bornTick: accept explicit tick or ageYears
    const bornTick = typeof opts.tick !== 'undefined'
      ? opts.tick
      : typeof opts.ageYears !== 'undefined'
        ? (this.world ? this.world.tick : 0) - Math.round(opts.ageYears * YEAR_TICKS)
        : 0;

    this.worldTick = bornTick;

    this.seq = ++seq;
    // allow caller to supply id (old code did this), otherwise generate one
    this.id = opts.id || `a${this.seq}`;
    this.name = opts.name || opts.id || `person-${this.seq}`;
    this.genome = opts.genome || { learning: 0.5, fertility: 0.5, resilience: 0.5, stamina: 0.5, longevity: 1, expressive: 0.5, sex: 'f' };
    this.x = opts.x || 0; this.y = opts.y || 0;
    this.bornTick = bornTick;
    this.parents = opts.parents || [];
    this.children = opts.children || [];
    this.partner = opts.partner || null;
    this.culture = opts.culture || null;

    this.body = {
      energy: 0.85, hunger: 0.2, thirst: 0.2, health: 1,
      warmth: 0.7, rest: 0.9, illness: 0, injury: 0, pregnant: null,
    };
    this.inventory = new Map();
    this.skills = {};
    for (const s of SKILLS) this.skills[s] = 0.02 + ((this.genome.learning || 0.5) - 0.5) * 0.02;

    this.affect = blankAffect();
    this.memory = new MemoryStore(240 + Math.round((this.genome.learning || 0.5) * 220));
    this.relationships = new Map();
    this.values = new Map();       // conceptKey -> subjective worth
    this.reputation = typeof opts.reputation !== 'undefined' ? opts.reputation : 0.5;
    this.home = opts.home || null;
    this.role = opts.role || 'wanderer';
    this.goal = opts.goal || null;
    this.action = null;            // { name, ticksLeft, target, ... }
    this.path = null;
    this.alive = typeof opts.alive === 'undefined' ? true : opts.alive;
    this.deathCause = null;
    this.deathTick = null;
    this.utterance = null;
    this.lastSpokeTick = -99;
    this.stats = Object.assign({
      harvested: 0, crafted: 0, built: 0, taught: 0, learned: 0, trades: 0,
      gifts: 0, meals: 0, inventions: 0, births: 0, fights: 0, rescues: 0,
      steps: 0, words: 0, ideas: 0, buried: 0, thefts: 0,
    }, opts.stats || {});
    this.traits = dominantTraits(this.genome);
    this.titles = opts.titles || [];
  }

  get age() { return (this.worldTick - this.bornTick) / YEAR_TICKS; }
  ageAt(tick) { return (tick - this.bornTick) / YEAR_TICKS; }
  isChild(tick) { return this.ageAt(tick) < 13; }
  isElder(tick) { return this.ageAt(tick) > 52 * this.genome.longevity; }

  // ââ inventory ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ[...]
  count(key) { return this.inventory.get(key) || 0; }
  add(key, n = 1) { this.inventory.set(key, this.count(key) + n); }
  take(key, n = 1) {
    const have = this.count(key);
    const got = Math.min(have, n);
    if (got <= 0) return 0;
    if (have - got <= 0.001) this.inventory.delete(key); else this.inventory.set(key, have - got);
    return got;
  }
  carried() { let t = 0; for (const v of this.inventory.values()) t += v; return t; }
  get carryLimit() { return 12 + this.skills.craft * 8 + (this.genome.stamina || 0) * 6; }

  /** The best thing they own for a purpose, according to what they know. */
  bestToolFor(fn, ontology) {
    if (this._toolTick !== this.worldTick) { this._toolTick = this.worldTick; this._toolMemo = new Map(); }
    if (this._toolMemo && this._toolMemo.has && this._toolMemo.has(fn)) return this._toolMemo.get(fn);
    let best = null, score = 0;
    for (const key of this.inventory.keys()) {
      const c = ontology.get(key);
      if (!c) continue;
      const s = c.serves(fn);
      if (s > score) { score = s; best = { key, concept: c, score: s }; }
    }
    if (!this._toolMemo) this._toolMemo = new Map();
    this._toolMemo.set(fn, best);
    return best;
  }

  // ââ relationships ââââââââââââââââââââââââââââââââââââââââââââââââââââââââï¿½ï¿½[...]
  rel(other) {
    const id = typeof other === 'string' ? other : other.id;
    let r = this.relationships.get(id);
    if (!r) {
      r = { id, familiarity: 0, affection: 0, trust: 0.1, respect: 0.1, debt: 0, kin: 0, conflicts: 0, exchanges: 0, lastGiftTick: -999, lastSeen: 0 };
      this.relationships.set(id, r);
    }
    return r;
  }
  adjustRel(other, delta) {
    const r = this.rel(other);
    for (const [k, v] of Object.entries(delta)) {
      r[k] = k === 'debt' ? r[k] + v : clamp(r[k] + v, k === 'affection' ? -1 : 0, 1);
    }
    return r;
  }
  closest(n = 3) {
    return [...this.relationships.values()]
      .sort((a, b) => (b.affection + b.trust + b.familiarity) - (a.affection + a.trust + a.familiarity))
      .slice(0, n);
  }

  // ââ value beliefs (subjective economics) ââââââââââââââââââââââââââââââââââ
  valueOf(key, ontology) {
    if (this.values.has(key)) return this.values.get(key);
    const c = ontology.get(key);
    const base = c ? 0.4 + c.bestScore * 1.2 + c.tier * 0.15 : 0.5;
    this.values.set(key, base);
    return base;
  }
  updateValue(key, observed, weight = 0.25) {
    const cur = this.values.get(key) ?? observed;
    this.values.set(key, clamp(cur * (1 - weight) + observed * weight, 0.05, 12));
  }

  /** Marginal desire for one more unit â scarcity and need shape it. */
  desireFor(key, ontology, sim) {
    const c = ontology.get(key);
    if (!c) return 0;
    let d = this.valueOf(key, ontology);
    const have = this.count(key);
    // Food is the one thing worth holding several of; tools are not.
    const foodish = (c.functions.sustenance || 0) > 0.2;
    d /= 1 + have * (foodish ? 0.16 : 1.1);                  // diminishing returns
    if (c.functions.sustenance) d *= 1 + this.body.hunger * 2.4;
    if (c.functions.clothing || c.functions.heat) d *= 1 + (1 - this.body.warmth) * 1.8;
    if (c.functions.medicine) d *= 1 + this.body.illness * 3;
    if (c.functions.art || c.functions.music) d *= 0.7 + this.genome.expressive * 1.1;
    for (const fn of Object.keys(c.functions)) {
      const mine = this.bestToolFor(fn, ontology);
      if (!mine || c.functions[fn] > mine.score * 1.1) d *= 1.25;
    }
    // Raw stuff the settlement is visibly short of feels worth carrying home.
    if (sim && c.kind === 'matter' && sim.wantedMaterials) {
      const want = sim.wantedMaterials.get(key);
      if (want) d *= 1 + want * 1.6;
    }
    return d;
  }

  gainSkill(skill, amount) {
    const cap = 1;
    const rate = amount * this.genome.learning * (1 - this.skills[skill] * 0.7);
    this.skills[skill] = clamp(this.skills[skill] + rate, 0, cap);
    return rate;
  }

  say(text, kind = 'speech') {
    this.utterance = { text, kind, tick: this.worldTick };
    this.lastSpokeTick = this.worldTick;
    this.stats.words++;
  }

  snapshotVitality() {
    const b = this.body;
    return clamp(b.health * 0.4 + (1 - b.hunger) * 0.25 + b.energy * 0.2 + b.warmth * 0.15);
  }
}
