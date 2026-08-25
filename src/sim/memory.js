// Memory has two layers: episodes (what happened to me) and a semantic graph
// (what I believe about the world). Episodes decay unless they mattered —
// landmark experiences are flagged permanent and are never pruned. Every event
// also goes into the world Chronicle, which forgets nothing, ever.

import { clamp, topN } from '../core/util.js';

const LANDMARK_KINDS = new Set([
  'birth', 'death', 'bond', 'betrayal', 'invention', 'first', 'violence',
  'rescue', 'gift', 'exile', 'law', 'ritual', 'teach', 'famine', 'migration',
]);

let mid = 0;

export class MemoryStore {
  constructor(capacity = 320) {
    this.episodes = [];        // ordinary recollections, which fade and can be lost
    this.core = [];            // the things a life is built on; these are never pruned
    this.capacity = capacity;
    this.semantic = new Map();  // key -> belief
    this.edges = new Map();     // `${a}|${rel}|${b}` -> weight
    this.pruned = 0;
  }

  remember(ev) {
    const salience = clamp(
      (Math.abs(ev.valence ?? 0) * 0.5 + (ev.intensity ?? 0.3) * 0.5) *
      (LANDMARK_KINDS.has(ev.kind) ? 1.5 : 1), 0, 1,
    );
    const m = {
      id: ++mid,
      tick: ev.tick,
      kind: ev.kind,
      text: ev.text,
      actors: ev.actors || [],
      place: ev.place || null,
      concept: ev.concept || null,
      valence: ev.valence ?? 0,
      salience,
      strength: 0.55 + salience * 0.45,
      permanent: LANDMARK_KINDS.has(ev.kind) || salience > 0.78,
      recalls: 0,
    };
    if (m.permanent) this.core.push(m);
    else {
      this.episodes.push(m);
      if (this.episodes.length > this.capacity) this.prune();
    }
    return m;
  }

  /** Forgetting the ordinary. Landmarks in `core` are exempt: what mattered stays. */
  prune() {
    const room = Math.max(40, Math.round(this.capacity * 0.8));
    if (this.episodes.length <= room) return;
    this.episodes.sort((a, b) => (b.strength * (0.5 + b.salience)) - (a.strength * (0.5 + a.salience)));
    this.pruned += this.episodes.length - room;
    this.episodes.length = room;
    this.episodes.sort((a, b) => a.tick - b.tick);
  }

  /** Slow forgetting of unimportant things; rehearsal strengthens the rest. */
  fade(rate = 0.0015) {
    for (const m of this.episodes) {
      if (m.permanent) continue;
      m.strength = clamp(m.strength - rate * (1 - m.salience), 0, 1);
    }
  }

  /**
   * Slow forgetting for BELIEFS, not just episodes. Without this, semantic
   * confidence — once learned — never revisits itself unless something
   * explicitly relearns that exact key, so stale beliefs sit unchanged
   * forever even after the world has moved on. Lessons (hard-won reflective
   * beliefs) are exempt; ordinary factual/place/recipe beliefs are not.
   */
  fadeBeliefs(rate = 0.0008) {
    for (const b of this.semantic.values()) {
      if (b.kind === 'lesson') continue;
      b.confidence = clamp(b.confidence - rate * (1 - Math.abs(b.valence)), 0, 1);
    }
  }

  recall(filter, n = 6) {
    const hits = [];
    for (const m of this.core) if (filter(m)) hits.push(m);
    for (const m of this.episodes) if (filter(m)) hits.push(m);
    const out = topN(hits, n, (m) => m.strength * (0.6 + m.salience) + m.tick * 1e-9);
    for (const m of out) { m.recalls++; m.strength = clamp(m.strength + 0.05, 0, 1); }
    return out;
  }

  about(actorId, n = 6) { return this.recall((m) => m.actors.includes(actorId), n); }
  aboutConcept(key, n = 4) { return this.recall((m) => m.concept === key, n); }

  // ── Semantic layer ────────────────────────────────────────────────────────
  /**
   * Learn or update a belief. Confidence is no longer a one-way ratchet: a
   * disconfirming observation (low confidence paired with negative valence —
   * e.g. "I went to where I thought the berries were, and there were none")
   * can pull existing confidence DOWN, not just slow its climb. Without this,
   * a belief that reality keeps contradicting only ever gets more certain and
   * sadder, which is the opposite of learning.
   */
  learn(key, { kind = 'fact', confidence = 0.4, valence = 0, source = 'experience', payload = null } = {}) {
    const cur = this.semantic.get(key);
    if (cur) {
      const disconfirming = valence < 0;
      const target = disconfirming ? confidence * 0.5 : confidence;
      const pull = disconfirming ? 0.35 : (1 - cur.confidence);
      cur.confidence = clamp(cur.confidence + (target - cur.confidence) * pull, 0, 1);
      cur.valence = cur.valence * 0.7 + valence * 0.3;
      cur.reinforced++;
      if (payload) cur.payload = { ...(cur.payload || {}), ...payload };
      return cur;
    }
    const b = { key, kind, confidence: clamp(confidence, 0, 1), valence, source, payload, reinforced: 0, learnedAt: null };
    this.semantic.set(key, b);
    return b;
  }

  knows(key, threshold = 0.12) { return (this.semantic.get(key)?.confidence || 0) >= threshold; }
  belief(key) { return this.semantic.get(key) || null; }
  knownKeys(kind = null) {
    const out = [];
    for (const b of this.semantic.values()) if ((!kind || b.kind === kind) && b.confidence > 0.12) out.push(b.key);
    return out;
  }

  link(a, rel, b, weight = 0.3) {
    const k = `${a}|${rel}|${b}`;
    this.edges.set(k, clamp((this.edges.get(k) || 0) + weight, 0, 1));
  }
  related(a, rel = null) {
    const out = [];
    for (const [k, w] of this.edges) {
      const [x, r, y] = k.split('|');
      if (x === a && (!rel || r === rel)) out.push({ key: y, rel: r, weight: w });
    }
    return out;
  }

  /** Sleep consolidation: repeated episodes harden into semantic beliefs. */
  consolidate(agent) {
    const counts = new Map();
    for (const m of this.episodes.slice(-40).concat(this.core.slice(-20))) {
      if (!m.concept) continue;
      const c = counts.get(m.concept) || { n: 0, v: 0 };
      c.n++; c.v += m.valence;
      counts.set(m.concept, c);
    }
    for (const [key, c] of counts) {
      if (c.n >= 3) this.learn(key, { kind: 'concept', confidence: 0.1 + c.n * 0.03, valence: c.v / c.n, source: 'reflection' });
    }
    // Grief and joy leave permanent traces on personality-adjacent beliefs.
    const strongest = topN(this.core.length ? this.core : this.episodes, 1, (m) => m.salience)[0];
    if (strongest && strongest.salience > 0.8) this.learn(`lesson:${strongest.kind}`, { kind: 'lesson', confidence: 0.3, valence: strongest.valence, source: 'reflection' });
  }

  stats() {
    return {
      episodes: this.episodes.length + this.core.length,
      permanent: this.core.length,
      pruned: this.pruned,
      beliefs: this.semantic.size,
      links: this.edges.size,
    };
  }
}
