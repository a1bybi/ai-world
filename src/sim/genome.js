// Heritable variation. Nothing is optimised by the simulation — selection is a
// side effect of who survives long enough to have children and teach them.

import { clamp } from '../core/util.js';

export const GENES = {
  metabolism:   [0.6, 1.4],   // how fast hunger accrues
  stamina:      [0.6, 1.4],   // energy pool & recovery
  resilience:   [0.5, 1.5],   // disease + injury resistance
  longevity:    [0.6, 1.4],   // lifespan multiplier
  fertility:    [0.4, 1.5],
  learning:     [0.5, 1.6],   // skill & knowledge acquisition rate
  curiosity:    [0, 1],       // drive to explore & experiment
  sociability:  [0, 1],       // drive to be near others, talk, gossip
  industry:     [0, 1],       // tolerance for labour
  aggression:   [0, 1],
  empathy:      [0, 1],
  risk:         [0, 1],       // willingness to accept danger
  patience:     [0, 1],       // long-horizon planning
  acuity:       [0.5, 1.5],   // perception radius
  expressive:   [0, 1],       // how much they speak & make art
};

const KEYS = Object.keys(GENES);

export function randomGenome(rng) {
  const g = {};
  for (const k of KEYS) {
    const [lo, hi] = GENES[k];
    g[k] = clamp(rng.float(lo, hi) * 0.6 + rng.float(lo, hi) * 0.4, lo, hi);
  }
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
  return g;
}

export function genomeDistance(a, b) {
  let s = 0;
  for (const k of KEYS) {
    const [lo, hi] = GENES[k];
    s += Math.abs(a[k] - b[k]) / (hi - lo);
  }
  return s / KEYS.length;
}

export function dominantTraits(g, n = 3) {
  const social = ['curiosity', 'sociability', 'industry', 'aggression', 'empathy', 'risk', 'patience', 'expressive'];
  return social
    .map((k) => ({ k, v: g[k] }))
    .sort((x, y) => y.v - x.v)
    .slice(0, n)
    .map((t) => t.k);
}
