// ─────────────────────────────────────────────────────────────────────────────
// The open-ended technology engine.
//
// There is NO tech tree. Nothing is pre-authored beyond raw matter and a handful
// of physical processes. Inhabitants invent by recombining things they know
// through processes they know; the properties of the result are computed from
// physics-ish rules, and the result becomes a new input for future invention.
// Because outputs feed back in as inputs, the space of reachable artefacts is
// unbounded and every civilisation walks a different path through it.
// ─────────────────────────────────────────────────────────────────────────────

import { clamp } from '../core/util.js';

/** Property vector. All values 0..1 unless noted. */
const P = (o = {}) => ({
  hard: 0, sharp: 0, flexible: 0, flammable: 0, nutrition: 0, warmth: 0,
  durable: 0, binder: 0, hollow: 0, liquid: 0, symbolic: 0, mass: 0.3,
  toxic: 0, preserved: 0, conductive: 0, luminous: 0, ...o,
});

export const RAW_MATTER = [
  { key: 'wood', props: P({ hard: 0.45, flammable: 0.8, durable: 0.4, mass: 0.4 }), from: 'forest' },
  { key: 'stone', props: P({ hard: 0.9, durable: 0.85, mass: 0.8 }), from: 'rock' },
  { key: 'fibre', props: P({ flexible: 0.9, binder: 0.5, flammable: 0.6, mass: 0.1 }), from: 'meadow' },
  { key: 'clay', props: P({ flexible: 0.6, hard: 0.2, mass: 0.5, hollow: 0.2 }), from: 'river' },
  { key: 'water', props: P({ liquid: 1, mass: 0.35 }), from: 'river' },
  { key: 'berry', props: P({ nutrition: 0.48, flammable: 0.1, mass: 0.05 }), from: 'forest' },
  { key: 'grain', props: P({ nutrition: 0.42, preserved: 0.3, mass: 0.08 }), from: 'meadow' },
  { key: 'root', props: P({ nutrition: 0.5, hard: 0.1, mass: 0.12 }), from: 'meadow' },
  { key: 'meat', props: P({ nutrition: 0.85, toxic: 0.25, mass: 0.3 }), from: 'game' },
  { key: 'hide', props: P({ flexible: 0.7, warmth: 0.7, durable: 0.5, mass: 0.2 }), from: 'game' },
  { key: 'bone', props: P({ hard: 0.65, durable: 0.6, sharp: 0.2, mass: 0.2 }), from: 'game' },
  { key: 'ore', props: P({ hard: 0.8, mass: 0.9, conductive: 0.4 }), from: 'rock' },
  { key: 'reed', props: P({ flexible: 0.85, hollow: 0.5, flammable: 0.5, mass: 0.08 }), from: 'river' },
  { key: 'resin', props: P({ binder: 0.9, flammable: 0.7, mass: 0.1 }), from: 'forest' },
];

/** Physical processes. Some are known from the start; others are themselves discovered. */
export const PROCESSES = {
  strike:  { innate: true,  needs: (a, b) => a.hard > 0.5, effect: (o, a, b) => { o.sharp += 0.45 * a.hard; o.mass *= 0.6; o.hollow += 0.05; } },
  bind:    { innate: true,  needs: (a, b) => a.binder > 0.3 || b.binder > 0.3 || a.flexible > 0.6 || b.flexible > 0.6, effect: (o, a, b) => { o.durable += 0.3; o.flexible = Math.max(a.flexible, b.flexible) * 0.8; } },
  shape:   { innate: true,  needs: (a) => a.flexible > 0.4 || a.hard < 0.5, effect: (o, a) => { o.hollow += 0.4; o.symbolic += 0.1; } },
  dry:     { innate: true,  needs: () => true, effect: (o, a) => { o.preserved += 0.5; o.mass *= 0.85; o.flammable += 0.15; } },
  grind:   { innate: true,  needs: (a, b) => a.hard > 0.55 || b.hard > 0.55, effect: (o, a, b) => { o.nutrition *= 1.35; o.mass *= 0.7; o.sharp += 0.1; } },
  burn:    { innate: false, needs: (a, b) => a.flammable > 0.4 || b.flammable > 0.4, effect: (o, a, b) => { o.nutrition *= 1.4; o.toxic *= 0.15; o.hard += 0.25; o.warmth += 0.4; o.luminous += 0.5; o.flammable *= 0.4; }, requiresFn: 'heat' },
  weave:   { innate: false, needs: (a, b) => (a.flexible + b.flexible) / 2 > 0.6, effect: (o, a, b) => { o.durable += 0.35; o.warmth += 0.35; o.flexible += 0.1; }, requiresFn: 'cordage' },
  ferment: { innate: false, needs: (a, b) => a.liquid > 0.5 || b.liquid > 0.5, effect: (o, a, b) => { o.preserved += 0.45; o.nutrition *= 1.15; o.symbolic += 0.3; }, requiresFn: 'vessel' },
  smelt:   { innate: false, needs: (a, b) => a.conductive > 0.2 || b.conductive > 0.2, effect: (o, a, b) => { o.hard += 0.35; o.durable += 0.4; o.sharp += 0.25; o.conductive += 0.4; o.mass *= 0.8; }, requiresFn: 'furnace' },
  carve:   { innate: false, needs: (a) => a.hard > 0.3, effect: (o, a) => { o.symbolic += 0.5; o.sharp += 0.1; o.mass *= 0.8; }, requiresFn: 'blade' },
  temper:  { innate: false, needs: (a, b) => a.conductive > 0.4 || a.hard > 0.7, effect: (o) => { o.hard += 0.2; o.durable += 0.3; o.sharp += 0.2; }, requiresFn: 'metal' },
  inscribe:{ innate: false, needs: (a) => a.durable > 0.4 || a.flexible > 0.5, effect: (o) => { o.symbolic += 0.7; }, requiresFn: 'blade' },
};

/**
 * Functions are what an artefact is GOOD FOR. Discovered by use, not declared.
 * Each maps a property vector to a capability score.
 */
export const FUNCTIONS = {
  cutting:   (p) => p.sharp * (0.4 + p.hard) * (0.6 + p.durable),
  cordage:   (p) => p.flexible * (0.4 + p.binder + p.durable * 0.5),
  vessel:    (p) => p.hollow * (0.4 + p.durable) * (1 - p.liquid * 0.5),
  heat:      (p) => p.luminous * 0.6 + p.warmth * 0.8 + p.flammable * 0.3,
  furnace:   (p) => p.hard * p.durable * (0.2 + p.hollow) * 2,
  clothing:  (p) => p.warmth * (0.3 + p.flexible) * (0.5 + p.durable),
  shelter:   (p) => p.durable * (0.3 + p.hard) * (0.4 + p.mass),
  sustenance:(p) => p.nutrition * (1 - p.toxic * 0.8),
  storage:   (p) => p.hollow * p.preserved * 1.6 + p.preserved * 0.4,
  weapon:    (p) => p.sharp * (0.3 + p.hard) * (0.4 + p.mass) * 1.2,
  metal:     (p) => p.conductive * p.hard,
  blade:     (p) => p.sharp * p.hard * 1.4,
  medicine:  (p) => (1 - p.toxic) * p.preserved * p.nutrition * 1.5,
  art:       (p) => p.symbolic * (0.4 + p.durable),
  record:    (p) => p.symbolic * p.preserved * 2,
  music:     (p) => p.hollow * p.symbolic * 1.8,
};

const FUNCTION_KEYS = Object.keys(FUNCTIONS);

export function bestFunction(props) {
  let best = null, bestScore = 0;
  for (const k of FUNCTION_KEYS) {
    const s = FUNCTIONS[k](props);
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return { fn: best, score: bestScore };
}

export function functionProfile(props) {
  const out = {};
  for (const k of FUNCTION_KEYS) {
    const s = FUNCTIONS[k](props);
    if (s > 0.08) out[k] = s;
  }
  return out;
}

export class Concept {
  constructor({ key, kind, props, parents = [], process = null, tier = 0 }) {
    this.key = key;
    this.kind = kind;                 // matter | artefact | food | structure | idea
    this.props = props;
    this.parents = parents;
    this.process = process;
    this.tier = tier;
    this.functions = functionProfile(props);
    const b = bestFunction(props);
    this.bestFn = b.fn;
    this.bestScore = b.score;
    this.discoveredBy = null;
    this.discoveredTick = 0;
    this.word = key;
    this.uses = 0;
    this.abundance = 0;
  }
  serves(fn) { return this.functions[fn] || 0; }
}

/** The shared, growing body of everything this world's people know exists. */
export class Ontology {
  constructor(rng, language) {
    this.rng = rng;
    this.lang = language;
    this.concepts = new Map();
    this.processesKnown = new Set(Object.keys(PROCESSES).filter((k) => PROCESSES[k].innate));
    this.bestFor = new Map();   // fn -> {conceptKey, score}
    this.inventions = [];       // chronological
    this.deadEnds = 0;
    this.attempts = 0;

    for (const m of RAW_MATTER) {
      const c = new Concept({ key: m.key, kind: 'matter', props: m.props, tier: 0 });
      c.word = language.word(m.key);
      c.source = m.from;
      this.concepts.set(m.key, c);
      this.noteBest(c);
    }
  }

  get(key) { return this.concepts.get(key); }
  all() { return [...this.concepts.values()]; }

  /** Raw stuff of the world. Cached: it changes only when the world does. */
  matter() {
    if (!this._matter || this._matterSize !== this.concepts.size) {
      this._matter = [...this.concepts.values()].filter((c) => c.kind === 'matter');
      this._matterSize = this.concepts.size;
    }
    return this._matter;
  }

  noteBest(c) {
    for (const [fn, score] of Object.entries(c.functions)) {
      const cur = this.bestFor.get(fn);
      if (!cur || score > cur.score) this.bestFor.set(fn, { key: c.key, score });
    }
  }

  bestScoreFor(fn) { return this.bestFor.get(fn)?.score || 0; }

  /** Ideas nobody keeps, uses, or remembers eventually stop being ideas at all.
   *  This is forgetting at the level of a whole culture, and it keeps the world finite. */
  prune(livingAgents, cap = 900) {
    if (this.concepts.size <= cap) return 0;
    const keep = new Set();
    for (const [key, c] of this.concepts) if (c.kind === 'matter') keep.add(key);
    for (const b of this.bestFor.values()) keep.add(b.key);
    for (const a of livingAgents) {
      for (const k of a.inventory.keys()) keep.add(k);
      for (const k of a.memory.knownKeys('recipe')) keep.add(k);
    }
    const doomed = [];
    for (const [key, c] of this.concepts) {
      if (keep.has(key)) continue;
      if (c.uses > 2) continue;
      doomed.push([key, c]);
    }
    doomed.sort((x, y) => (x[1].uses - y[1].uses) || (x[1].bestScore - y[1].bestScore));
    let removed = 0;
    for (const [key] of doomed) {
      if (this.concepts.size - removed <= cap) break;
      this.concepts.delete(key);
      removed++;
    }
    return removed;
  }

  /** Which processes an agent can actually perform, given what the world can make. */
  availableProcesses() {
    const out = [];
    for (const [name, proc] of Object.entries(PROCESSES)) {
      if (proc.innate) { out.push(name); continue; }
      if (this.processesKnown.has(name)) { out.push(name); continue; }
      if (proc.requiresFn && this.bestScoreFor(proc.requiresFn) > 0.32) {
        this.processesKnown.add(name);
        out.push(name);
      }
    }
    return out;
  }

  /**
   * Attempt an invention. Returns a result object describing what happened —
   * a genuine advance, a curiosity, or a failure. Nothing here is scripted.
   */
  attempt(agent, aKey, bKey, processName) {
    this.attempts++;
    const a = this.concepts.get(aKey);
    const b = bKey ? this.concepts.get(bKey) : null;
    const proc = PROCESSES[processName];
    if (!a || !proc) return { ok: false, reason: 'unknown' };
    if (!proc.needs(a.props, b ? b.props : P())) { this.deadEnds++; return { ok: false, reason: 'physics' }; }

    const key = [processName, aKey, bKey].filter(Boolean).join('+');
    if (this.concepts.has(key)) {
      const existing = this.concepts.get(key);
      return { ok: false, reason: 'known', concept: existing };
    }

    // Blend parent properties, then apply the process transform.
    const props = P();
    const keys = Object.keys(props);
    for (const k of keys) {
      const av = a.props[k] || 0;
      const bv = b ? (b.props[k] || 0) : 0;
      props[k] = b ? Math.max(av, bv) * 0.72 + Math.min(av, bv) * 0.38 : av;
    }
    proc.effect(props, a.props, b ? b.props : P());
    // Variation: craftsmanship and luck. Skilled hands make better things.
    const craft = 0.85 + (agent?.skills?.craft ?? 0) * 0.35;
    for (const k of keys) props[k] = clamp(props[k] * craft * this.rng.float(0.92, 1.1), 0, 1);
    props.mass = clamp(props.mass, 0.02, 1);

    const c = new Concept({
      key, kind: props.nutrition > 0.35 ? 'food' : 'artefact',
      props, parents: b ? [aKey, bKey] : [aKey], process: processName,
      tier: Math.max(a.tier, b ? b.tier : 0) + 1,
    });
    if (!c.bestFn || c.bestScore < 0.06) { this.deadEnds++; return { ok: false, reason: 'useless' }; }
    // Most things you can make are not worth keeping. A thing has to earn its name.
    if (c.bestScore < this.bestScoreFor(c.bestFn) * 0.45) { this.deadEnds++; return { ok: false, reason: 'worse' }; }

    // Is it better than anything they have for its purpose?
    const prior = this.bestScoreFor(c.bestFn);
    const advance = c.bestScore > prior * 1.05 + 0.02;

    c.word = this.lang.word(key, b ? [aKey, bKey] : null);
    c.discoveredBy = agent?.id ?? null;
    this.concepts.set(key, c);
    this.noteBest(c);
    const record = {
      key, word: c.word, fn: c.bestFn, score: c.bestScore, prior,
      process: processName, parents: c.parents, tier: c.tier, advance,
      by: agent?.name ?? 'the world', byId: agent?.id ?? null,
    };
    this.inventions.push(record);
    return { ok: true, concept: c, advance, record };
  }

  /** Aggregate capability — used to name eras, not to gate them. */
  capability() {
    let total = 0, n = 0;
    for (const fn of FUNCTION_KEYS) { total += this.bestScoreFor(fn); n++; }
    return total / n;
  }

  breadth() {
    let served = 0;
    for (const fn of FUNCTION_KEYS) if (this.bestScoreFor(fn) > 0.2) served++;
    return served / FUNCTION_KEYS.length;
  }
}
