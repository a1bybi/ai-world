// Memory has two layers: episodes (what happened to me) and a semantic graph
// (what I believe about the world). Episodes decay unless they mattered —
// landmark experiences are flagged permanent and are never pruned. Every event
// also goes into the world Chronicle, which forgets nothing, ever.
//
// Norms are ordinary beliefs with kind === 'norm'. They are formed from
// repeated lived patterns (reflection), transferred in talk/teaching, and
// can fade unless reinforced — nothing is law because it was seeded.

import { clamp, topN } from '../core/util.js';

const LANDMARK_KINDS = new Set([
  'birth', 'death', 'bond', 'betrayal', 'invention', 'first', 'violence',
  'rescue', 'gift', 'exile', 'law', 'ritual', 'teach', 'famine', 'migration',
  'theft', 'neglect', 'witness',
]);

/** Episode kinds that, when repeated with negative valence, suggest a prohibition. */
const NORM_NEGATIVE_KINDS = new Set([
  'neglect', 'betrayal', 'theft', 'violence', 'witness', 'injury',
]);

/** Episode kinds that, when repeated with positive valence, suggest a duty/virtue. */
const NORM_POSITIVE_KINDS = new Set([
  'gift', 'teach', 'rescue', 'ritual', 'burial', 'bond',
]);

/** Default human-readable labels when none was stored on the belief payload. */
const NORM_LABELS = {
  theft: 'what is not given must not be taken',
  violence: 'hands are not raised against our own',
  neglect: 'the hungry are not left to watch the fed',
  sharing: 'the hungry are fed from what we have',
  burial: 'the dead are put into the ground with words',
  teaching: 'what one knows, all may learn',
  craft: 'a thing well made is owed respect',
  gift: 'what one can spare, one may give',
  rescue: 'the hurt are tended',
  betrayal: 'trust broken is not quickly mended',
};

export class MemoryStore {
  /**
   * @param {number} [capacity=320] Max ordinary episodes kept after pruning.
   * @param {object} [opts]
   * @param {Iterable<string>} [opts.landmarkKinds] Extra kinds treated as permanent.
   */
  constructor(capacity = 320, opts = {}) {
    this.episodes = [];
    this.core = [];
    this.capacity = capacity;
    this.semantic = new Map();
    this.edges = new Map();
    this.pruned = 0;
    this._nextId = 0;

    this._landmarks = opts.landmarkKinds
      ? new Set([...LANDMARK_KINDS, ...opts.landmarkKinds])
      : LANDMARK_KINDS;
  }

  // ── Episodic layer ────────────────────────────────────────────────────────

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

  prune() {
    const room = Math.max(40, Math.round(this.capacity * 0.8));
    if (this.episodes.length <= room) return;

    this.episodes.sort(
      (a, b) =>
        b.strength * (0.5 + b.salience) - a.strength * (0.5 + a.salience),
    );
    this.pruned += this.episodes.length - room;
    this.episodes.length = room;
    this.episodes.sort((a, b) => a.tick - b.tick);
  }

  fade(rate = 0.0015) {
    for (const m of this.episodes) {
      m.strength = clamp(m.strength - rate * (1 - m.salience), 0, 1);
    }
  }

  recall(filter, n = 6) {
    const hits = [];
    for (const m of this.core) if (filter(m)) hits.push(m);
    for (const m of this.episodes) if (filter(m)) hits.push(m);

    const score = (m) =>
      m.strength * (0.6 + m.salience) + m.tick * 1e-9;

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
   * Confidence is bidirectional: disconfirming evidence (negative valence
   * against a positive belief, or the reverse) can pull confidence down.
   *
   * For kind === 'norm', payload is merged and evidence counts accumulate.
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
    const now = tick ?? Date.now();

    if (cur) {
      // Same-sign valence reinforces; opposite-sign is treated as disconfirming
      const sameSign =
        (cur.valence >= 0 && valence >= 0) ||
        (cur.valence < 0 && valence < 0);
      const disconfirming = !sameSign && Math.abs(valence) > 0.05;

      const target = disconfirming ? confidence * 0.55 : confidence;
      const pull = disconfirming ? 0.32 : 1 - cur.confidence;

      cur.confidence = clamp(
        cur.confidence + (target - cur.confidence) * pull,
        0,
        1,
      );
      cur.valence = cur.valence * 0.7 + valence * 0.3;
      cur.reinforced++;
      cur.lastUpdated = now;

      if (payload) {
        const prev = cur.payload || {};
        cur.payload = {
          ...prev,
          ...payload,
          evidence:
            (prev.evidence || 0) +
            (payload.evidence != null ? payload.evidence : 1),
        };
      }
      return cur;
    }

    const b = {
      key,
      kind,
      confidence: clamp(confidence, 0, 1),
      valence,
      source,
      payload: payload
        ? {
            ...payload,
            evidence: payload.evidence != null ? payload.evidence : 1,
          }
        : null,
      reinforced: 0,
      learnedAt: now,
      lastUpdated: now,
    };
    this.semantic.set(key, b);
    return b;
  }

  /**
   * Slow decay of ordinary beliefs.
   * Lessons are exempt (personality anchors).
   * Norms decay more slowly — social rules linger, but still fade without use.
   */
  fadeBeliefs(rate = 0.0008) {
    for (const b of this.semantic.values()) {
      if (b.kind === 'lesson') continue;
      const factor = b.kind === 'norm' ? 0.45 : 1;
      b.confidence = clamp(
        b.confidence - rate * factor * (1 - Math.abs(b.valence || 0)),
        0,
        1,
      );
      if (b.confidence < 0.008) b.confidence = 0;
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

  /** All normative beliefs above threshold, strongest first. */
  knownNorms(threshold = 0.12) {
    return [...this.semantic.values()]
      .filter((b) => b.kind === 'norm' && b.confidence >= threshold)
      .sort(
        (a, b) =>
          Math.abs(b.confidence * b.valence) -
          Math.abs(a.confidence * a.valence),
      );
  }

  // ── Relational graph ──────────────────────────────────────────────────────

  link(a, rel, b, weight = 0.3) {
    const k = `${a}|${rel}|${b}`;
    this.edges.set(k, clamp((this.edges.get(k) || 0) + weight, 0, 1));
  }

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

  pruneEdges(minWeight = 0.05) {
    for (const [k, w] of this.edges) {
      if (w < minWeight) this.edges.delete(k);
    }
  }

  // ── Consolidation ─────────────────────────────────────────────────────────

  /**
   * Sleep consolidation:
   *  - repeated concepts → semantic matter/concept beliefs
   *  - repeated social hurts/helps → personal normative beliefs
   *  - strongest core events → lasting lessons
   *
   * @param {object} [agent] optional; unused in base impl but kept for call sites
   */
  consolidate(agent) {
    const candidates = this.episodes.slice(-40).concat(this.core.slice(-20));

    // 1. Concept hardening
    const conceptCounts = new Map();
    for (const m of candidates) {
      if (!m.concept) continue;
      const c = conceptCounts.get(m.concept) || { n: 0, v: 0 };
      c.n++;
      c.v += m.valence;
      conceptCounts.set(m.concept, c);
    }
    for (const [key, c] of conceptCounts) {
      if (c.n >= 3) {
        this.learn(key, {
          kind: 'concept',
          confidence: 0.1 + c.n * 0.03,
          valence: c.v / c.n,
          source: 'reflection',
          tick: candidates[candidates.length - 1]?.tick,
        });
      }
    }

    // 2. Normative hypotheses from repeated social patterns
    this._consolidateNorms(candidates);

    // 3. Lesson from strongest permanent memory
    const pool = this.core.length ? this.core : this.episodes;
    const strongest = topN(pool, 1, (m) => m.salience)[0];
    if (strongest && strongest.salience > 0.8) {
      const lessonKey = `lesson:${strongest.kind}`;
      const existing = this.belief(lessonKey);
      this.learn(lessonKey, {
        kind: 'lesson',
        confidence: existing
          ? Math.max(existing.confidence, 0.35)
          : 0.35,
        valence: strongest.valence,
        source: 'reflection',
        tick: strongest.tick,
      });
    }
  }

  /**
   * Turn repeated appraisal/episode patterns into personal norm:* beliefs.
   * No authored society rule is required — only lived statistics.
   */
  _consolidateNorms(candidates) {
    const buckets = new Map(); // normKey -> { n, v, kind }

    for (const m of candidates) {
      let normKey = null;
      let polarityHint = 0;

      if (NORM_NEGATIVE_KINDS.has(m.kind) && m.valence < -0.15) {
        // Map episode kind → norm key
        const map = {
          neglect: 'neglect',
          betrayal: 'theft', // often theft-shaped; witness/theft also map below
          theft: 'theft',
          violence: 'violence',
          witness: null, // resolved via text/concept if present
          injury: 'violence',
        };
        normKey = map[m.kind];
        if (m.kind === 'witness') {
          if (m.concept === 'theft' || /thief|took|stole/i.test(m.text || ''))
            normKey = 'theft';
          else if (/blow|fight|struck|violence/i.test(m.text || ''))
            normKey = 'violence';
          else normKey = 'neglect';
        }
        polarityHint = -1;
      } else if (NORM_POSITIVE_KINDS.has(m.kind) && m.valence > 0.15) {
        const map = {
          gift: 'sharing',
          teach: 'teaching',
          rescue: 'rescue',
          ritual: 'burial',
          burial: 'burial',
          bond: 'sharing',
        };
        normKey = map[m.kind] || m.kind;
        polarityHint = 1;
      }

      if (!normKey) continue;
      const b = buckets.get(normKey) || { n: 0, v: 0, polarity: polarityHint };
      b.n++;
      b.v += m.valence;
      buckets.set(normKey, b);
    }

    for (const [normKey, c] of buckets) {
      if (c.n < 3) continue;
      const avgV = c.v / c.n;
      const key = `norm:${normKey}`;
      const label = NORM_LABELS[normKey] || normKey;

      this.learn(key, {
        kind: 'norm',
        confidence: 0.12 + c.n * 0.045,
        valence: avgV,
        source: 'reflection',
        payload: {
          situation: normKey,
          polarity: avgV < 0 ? -1 : 1,
          label,
          evidence: c.n,
        },
        tick: candidates[candidates.length - 1]?.tick,
      });
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  stats() {
    const norms = [...this.semantic.values()].filter(
      (b) => b.kind === 'norm' && b.confidence > 0.12,
    ).length;
    return {
      episodes: this.episodes.length + this.core.length,
      ordinary: this.episodes.length,
      permanent: this.core.length,
      pruned: this.pruned,
      beliefs: this.semantic.size,
      norms,
      links: this.edges.size,
    };
  }
}

export { LANDMARK_KINDS, NORM_LABELS, NORM_NEGATIVE_KINDS, NORM_POSITIVE_KINDS };
