// Memory has two layers: episodes (what happened to me) and a semantic graph
// (what I believe about the world). Episodes decay unless they mattered —
// landmark experiences are flagged permanent and are never pruned. Every event
// also goes into the world Chronicle, which forgets nothing, ever.

import { clamp, topN } from '../core/util.js';

const LANDMARK_KINDS = new Set([
  'birth', 'death', 'bond', 'betrayal', 'invention', 'first', 'violence',
  'rescue', 'gift', 'exile', 'law', 'ritual', 'teach', 'famine', 'migration',
]);

export class MemoryStore {
  /**
   * @param {number} [capacity=320] Max ordinary episodes kept after pruning.
   * @param {object} [opts]
   * @param {Iterable<string>} [opts.landmarkKinds] Extra kinds treated as permanent.
   */
  constructor(capacity = 320, opts = {}) {
    this.episodes = [];        // ordinary recollections — fade and can be lost
    this.core = [];            // life-defining memories — never pruned
    this.capacity = capacity;
    this.semantic = new Map(); // key -> belief
    this.edges = new Map();    // `${a}|${rel}|${b}` -> weight
    this.pruned = 0;
    this._nextId = 0;

    // Optional extension of landmark kinds
    this._landmarks = opts.landmarkKinds
      ? new Set([...LANDMARK_KINDS, ...opts.landmarkKinds])
      : LANDMARK_KINDS;
  }

  // ── Episodic layer ────────────────────────────────────────────────────────

  /**
   * Record an event. High-salience or landmark events become permanent (core).
   * @param {object} ev
   * @returns {object} the stored memory record
   */
  remember(ev) {
    const isLandmark = this._landmarks.has(ev.kind);
    const salience = clamp(
      (Math.abs(ev.valence ?? 0) * 0.5 + (ev.intensity ?? 0.3) * 0.5) *
        (isLandmark ? 1.5 : 1),
      0,
      1,
    );

    const m = {
      id: ++this._nextId,
      tick: ev.tick ?? 0,
      kind: ev.kind ?? 'event',
      text: ev.text ?? '',
      actors: Array.isArray(ev.actors) ? ev.actors : [],
      place: ev.place ?? null,
      concept: ev.concept ?? null,
      valence: ev.valence ?? 0,
      salience,
      strength: 0.55 + salience * 0.45,
      permanent: isLandmark || salience > 0.78,
      recalls: 0,
    };

    if (m.permanent) {
      this.core.push(m);
    } else {
      this.episodes.push(m);
      if (this.episodes.length > this.capacity) this.prune();
    }
    return m;
  }

  /**
   * Forgetting the ordinary. Core memories are exempt.
   * Keeps the strongest ~80 % of capacity (minimum 40).
   */
  prune() {
    const room = Math.max(40, Math.round(this.capacity * 0.8));
    if (this.episodes.length <= room) return;

    // Rank by current strength × salience, keep the top `room`
    this.episodes.sort(
      (a, b) =>
        b.strength * (0.5 + b.salience) - a.strength * (0.5 + a.salience),
    );
    this.pruned += this.episodes.length - room;
    this.episodes.length = room;

    // Restore chronological order for later slicing / consolidation
    this.episodes.sort((a, b) => a.tick - b.tick);
  }

  /**
   * Slow forgetting of unimportant episodes.
   * Higher-salience memories decay more slowly.
   * @param {number} [rate=0.0015]
   */
  fade(rate = 0.0015) {
    for (const m of this.episodes) {
      m.strength = clamp(m.strength - rate * (1 - m.salience), 0, 1);
    }
  }

  /**
   * Retrieve memories matching a predicate, ranked by strength, salience and
   * mild recency. Successful recall strengthens the memory (rehearsal).
   * @param {(m: object) => boolean} filter
   * @param {number} [n=6]
   */
  recall(filter, n = 6) {
    const hits = [];
    for (const m of this.core) if (filter(m)) hits.push(m);
    for (const m of this.episodes) if (filter(m)) hits.push(m);

    // Prefer strength + salience; add a soft recency term that stays bounded
    const score = (m) => {
      const ageBias = 1 / (1 + Math.max(0, (Date.now() / 1000 - m.tick) * 1e-6)); // optional; or use pure tick
      // Pure tick-based soft bias (works when tick is a simulation counter):
      return m.strength * (0.6 + m.salience) + m.tick * 1e-9;
    };

    const out = topN(hits, n, score);
    for (const m of out) {
      m.recalls++;
      m.strength = clamp(m.strength + 0.05, 0, 1);
    }
    return out;
  }

  about(actorId, n = 6) {
    return this.recall((m) => m.actors.includes(actorId), n);
  }

  aboutConcept(key, n = 4) {
    return this.recall((m) => m.concept === key, n);
  }

  // ── Semantic layer ────────────────────────────────────────────────────────

  /**
   * Learn or update a belief.
   * Confidence is bidirectional: disconfirming evidence (negative valence)
   * can lower existing confidence instead of only ratcheting upward.
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {string}  [opts.kind='fact']
   * @param {number}  [opts.confidence=0.4]
   * @param {number}  [opts.valence=0]
   * @param {string}  [opts.source='experience']
   * @param {object|null} [opts.payload=null]
   * @param {number|null} [opts.tick=null]  simulation tick when learned
   */
  learn(
    key,
    {
      kind = 'fact',
      confidence = 0.4,
      valence = 0,
      source = 'experience',
      payload = null,
      tick = null,
    } = {},
  ) {
    const cur = this.semantic.get(key);

    if (cur) {
      const disconfirming = valence < 0;
      // Incoming confidence is tempered when disconfirming
      const target = disconfirming ? confidence * 0.55 : confidence;
      // Pull strength: fixed modest pull on disconfirm, confidence-gap on confirm
      const pull = disconfirming ? 0.32 : 1 - cur.confidence;
      cur.confidence = clamp(
        cur.confidence + (target - cur.confidence) * pull,
        0,
        1,
      );
      cur.valence = cur.valence * 0.7 + valence * 0.3;
      cur.reinforced++;
      cur.lastUpdated = tick ?? Date.now();
      if (payload) {
        cur.payload = { ...(cur.payload || {}), ...payload };
      }
      return cur;
    }

    const b = {
      key,
      kind,
      confidence: clamp(confidence, 0, 1),
      valence,
      source,
      payload,
      reinforced: 0,
      learnedAt: tick ?? Date.now(),
      lastUpdated: tick ?? Date.now(),
    };
    this.semantic.set(key, b);
    return b;
  }

  /**
   * Slow decay of ordinary beliefs. Lessons (hard-won reflective beliefs)
   * are exempt so they remain stable personality anchors.
   * @param {number} [rate=0.0008]
   */
  fadeBeliefs(rate = 0.0008) {
    for (const b of this.semantic.values()) {
      if (b.kind === 'lesson') continue;
      b.confidence = clamp(
        b.confidence - rate * (1 - Math.abs(b.valence)),
        0,
        1,
      );
    }
  }

  knows(key, threshold = 0.12) {
    return (this.semantic.get(key)?.confidence || 0) >= threshold;
  }

  belief(key) {
    return this.semantic.get(key) || null;
  }

  knownKeys(kind = null) {
    const out = [];
    for (const b of this.semantic.values()) {
      if ((!kind || b.kind === kind) && b.confidence > 0.12) out.push(b.key);
    }
    return out;
  }

  // ── Relational graph ──────────────────────────────────────────────────────

  /**
   * Strengthen (or create) a directed relation a --rel--> b.
   * Weights are clamped to [0, 1].
   */
  link(a, rel, b, weight = 0.3) {
    const k = `${a}|${rel}|${b}`;
    this.edges.set(k, clamp((this.edges.get(k) || 0) + weight, 0, 1));
  }

  /**
   * Return outgoing relations from `a`. Optional filter by relation type.
   * Results are sorted by weight descending.
   */
  related(a, rel = null) {
    const out = [];
    for (const [k, w] of this.edges) {
      const [x, r, y] = k.split('|');
      if (x === a && (!rel || r === rel)) {
        out.push({ key: y, rel: r, weight: w });
      }
    }
    out.sort((p, q) => q.weight - p.weight);
    return out;
  }

  /**
   * Optional: prune very weak edges to keep the graph bounded.
   * @param {number} [minWeight=0.05]
   */
  pruneEdges(minWeight = 0.05) {
    for (const [k, w] of this.edges) {
      if (w < minWeight) this.edges.delete(k);
    }
  }

  // ── Consolidation ─────────────────────────────────────────────────────────

  /**
   * Sleep consolidation: repeated recent episodes harden into semantic beliefs.
   * High-salience core events can crystallize into permanent “lesson” beliefs.
   * @param {object} [agent] optional agent reference (unused in base impl)
   */
  consolidate(agent) {
    const counts = new Map();

    // Recent ordinary + recent core
    const candidates = this.episodes.slice(-40).concat(this.core.slice(-20));
    for (const m of candidates) {
      if (!m.concept) continue;
      const c = counts.get(m.concept) || { n: 0, v: 0 };
      c.n++;
      c.v += m.valence;
      counts.set(m.concept, c);
    }

    for (const [key, c] of counts) {
      if (c.n >= 3) {
        this.learn(key, {
          kind: 'concept',
          confidence: 0.1 + c.n * 0.03,
          valence: c.v / c.n,
          source: 'reflection',
        });
      }
    }

    // Strongest permanent memory can leave a lasting lesson
    const pool = this.core.length ? this.core : this.episodes;
    const strongest = topN(pool, 1, (m) => m.salience)[0];
    if (strongest && strongest.salience > 0.8) {
      const lessonKey = `lesson:${strongest.kind}`;
      const existing = this.belief(lessonKey);
      // Only create or gently reinforce; avoid overwriting with low confidence
      this.learn(lessonKey, {
        kind: 'lesson',
        confidence: existing ? Math.max(existing.confidence, 0.35) : 0.35,
        valence: strongest.valence,
        source: 'reflection',
      });
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  stats() {
    return {
      episodes: this.episodes.length + this.core.length,
      ordinary: this.episodes.length,
      permanent: this.core.length,
      pruned: this.pruned,
      beliefs: this.semantic.size,
      links: this.edges.size,
    };
  }
}
