// Heritable variation. Nothing is optimised by the simulation — selection is a
// side effect of who survives long enough to have children and teach them.
//
// Parallel to continuous traits: each person carries a short DNA marker string
// for observer traceability. Children inherit a mosaic of parental markers with
// rare mutation. Line labels let families read as houses across generations.

import { clamp } from '../core/util.js';

export const GENES = {
  metabolism:   [0.6, 1.4],
  stamina:      [0.6, 1.4],
  resilience:   [0.5, 1.5],
  longevity:    [0.6, 1.4],
  fertility:    [0.4, 1.5],
  learning:     [0.5, 1.6],
  curiosity:    [0, 1],
  sociability:  [0, 1],
  industry:     [0, 1],
  aggression:   [0, 1],
  empathy:      [0, 1],
  risk:         [0, 1],
  patience:     [0, 1],
  acuity:       [0.5, 1.5],
  expressive:   [0, 1],
};

const KEYS = Object.keys(GENES);

/** Number of discrete inheritance markers per person. */
export const DNA_MARKERS = 12;

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codeChunk(rng, n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPH[rng.int(0, ALPH.length - 1)];
  return s;
}

export function randomGenome(rng) {
  const g = {};
  for (const k of KEYS) {
    const [lo, hi] = GENES[k];
    g[k] = clamp(rng.float(lo, hi) * 0.6 + rng.float(lo, hi) * 0.4, lo, hi);
  }
  // Founders: no sex in original randomGenome - agent may set; keep optional
  if (g.sex == null) g.sex = rng.bool() ? 'f' : 'm';
  return g;
}

export function inherit(rng, a, b, mutationRate = 0.09) {
  const g = {};
  for (const k of KEYS) {
    const [lo, hi] = GENES[k];
    let v = rng.bool() ? a[k] : b[k];
    v = v * 0.7 + ((a[k] + b[k]) / 2) * 0.3;
    if (rng.bool(mutationRate)) v += rng.normal(0, (hi - lo) * 0.16);
    g[k] = clamp(v, lo, hi);
  }
  // Sex not averaged — coin flip for the child
  g.sex = rng.bool() ? 'f' : 'm';
  return g;
}

export function genomeDistance(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (const k of KEYS) {
    const [lo, hi] = GENES[k];
    s += Math.abs((a[k] ?? 0.5) - (b[k] ?? 0.5)) / (hi - lo);
  }
  return s / KEYS.length;
}

export function dominantTraits(g, n = 3) {
  const social = [
    'curiosity', 'sociability', 'industry', 'aggression',
    'empathy', 'risk', 'patience', 'expressive',
  ];
  return social
    .map((k) => ({ k, v: g[k] ?? 0 }))
    .sort((x, y) => y.v - x.v)
    .slice(0, n)
    .map((t) => t.k);
}

// ── DNA / lineage (observer identity; traits stay on genome) ─────────────

/**
 * Create a unique DNA record for a founder (no parents).
 * @param {object} rng
 * @param {string} [lineName] optional house name (often the person's name)
 */
export function inventDna(rng, lineName = null) {
  const markers = [];
  for (let i = 0; i < DNA_MARKERS; i++) {
    markers.push(rng.int(0, 99));
  }
  const id = `${codeChunk(rng, 4)}-${codeChunk(rng, 4)}`;
  return {
    id,
    markers,
    maternal: null,
    paternal: null,
    line: lineName || id.slice(0, 4),
  };
}

/**
 * Child DNA: mosaic of mother/father markers, rare mutation, new unique id.
 * Line prefers mother's line (matrilineal label for observer clarity), with a
 * small chance to take the father's when both exist.
 */
export function inheritDna(rng, motherDna, fatherDna = null, mutationRate = 0.06) {
  const mom = motherDna || inventDna(rng);
  const dad = fatherDna || mom;
  const markers = [];
  for (let i = 0; i < DNA_MARKERS; i++) {
    let v = rng.bool() ? (mom.markers[i] ?? rng.int(0, 99)) : (dad.markers[i] ?? rng.int(0, 99));
    if (rng.bool(mutationRate)) v = (v + rng.int(1, 9)) % 100;
    markers.push(v);
  }
  const id = `${codeChunk(rng, 4)}-${codeChunk(rng, 4)}`;
  let line = mom.line || mom.id?.slice(0, 4) || id.slice(0, 4);
  if (fatherDna?.line && rng.bool(0.35)) line = fatherDna.line;
  return {
    id,
    markers,
    maternal: mom.id || null,
    paternal: fatherDna?.id || null,
    line,
  };
}

/** Shared marker fraction in 0..1 */
export function dnaShare(a, b) {
  if (!a?.markers || !b?.markers) return 0;
  const n = Math.min(a.markers.length, b.markers.length);
  if (!n) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (a.markers[i] === b.markers[i]) same++;
  return same / n;
}

/** Compact display: ID + line */
export function dnaLabel(dna) {
  if (!dna?.id) return '—';
  return dna.line && dna.line !== dna.id.slice(0, 4)
    ? `${dna.id} (line ${dna.line})`
    : dna.id;
}

/**
 * Rank living people by how much DNA they share with `a` (excluding self).
 */
export function kinByDna(a, living, limit = 6) {
  if (!a?.dna) return [];
  return living
    .filter((o) => o && o.id !== a.id && o.alive && o.dna)
    .map((o) => ({
      id: o.id,
      name: o.name,
      share: dnaShare(a.dna, o.dna),
      line: o.dna.line,
    }))
    .filter((x) => x.share > 0.15)
    .sort((x, y) => y.share - x.share)
    .slice(0, limit);
}

/** Count living by line label */
export function lineCensus(living) {
  const m = new Map();
  for (const a of living) {
    if (!a?.alive || !a.dna?.line) continue;
    const k = a.dna.line;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .map(([line, n]) => ({ line, n }))
    .sort((a, b) => b.n - a.n);
}
