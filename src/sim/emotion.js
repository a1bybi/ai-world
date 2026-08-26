// Appraisal-theoretic emotion. Nothing sets "anger = 0.7" directly; emotions are
// derived from how an event was appraised relative to the agent's own goals,
// then they feed back into what the agent decides to do and what it remembers.

import { clamp, lerp } from '../core/util.js';

export const EMOTIONS = [
  'joy', 'sadness', 'fear', 'anger', 'disgust', 'surprise',
  'trust', 'anticipation', 'pride', 'shame', 'grief', 'love', 'awe', 'loneliness',
];

/** Slow-decaying emotions (grief & love linger). Multiplier applied to the decay rate. */
const PERSISTENT = new Set(['grief', 'love']);
const PERSISTENCE_FACTOR = 0.35; // ~3× longer half-life than ordinary emotions

/** Minimum multiplier returned by emotionalBias so utilities never invert. */
const BIAS_FLOOR = 0.15;

/**
 * Tunable weights for appraisal → emotion mapping.
 * Kept in one place so balance passes stay readable.
 */
const W = {
  joy: 1.0,
  prideSelf: 0.5,
  trustSocial: 0.4,
  anticipationLowCertainty: 0.4,
  sadnessBase: 0.6,
  sadnessResilience: 0.4,
  angerOther: 0.35,
  angerAggression: 0.85,
  shameSelf: 0.3,
  shameRisk: 0.5,
  fearWorld: 0.4,
  fearRisk: 0.7,
  fearUncertainty: 0.4,
  surprise: 1.0,
  aweNovelty: 0.3,
  aweCuriosity: 0.7,
  normShameAnger: 0.4,
  normEmpathy: 0.6,
  disgustNorm: 0.4,
  prideNorm: 0.3,
  griefEmpathy: 0.6,
  loveEmpathy: 0.5,
  lonelinessSociability: 1.0,
};

export function blankAffect() {
  const e = Object.create(null);
  for (const k of EMOTIONS) e[k] = 0;
  return {
    e,
    valence: 0,
    arousal: 0.12, // mild baseline “alive” arousal
    mood: 0,
  };
}

/**
 * appraise(agent, ev)
 *
 * ev: {
 *   goalCongruence: -1..1   did this help or hurt what I wanted
 *   agency: 'self'|'other'|'world'
 *   certainty: 0..1
 *   novelty: 0..1
 *   norm: -1..1              did it violate or uphold a norm I hold
 *   social: agentId | null
 *   intensity: 0..1
 *   kind: string
 * }
 *
 * Mutates agent.affect in place and returns it.
 */
export function appraise(agent, ev) {
  const a = agent.affect;
  const g = agent.genome;

  // Defensive genome clamps (assume 0–1, but never trust)
  const resilience = clamp(g.resilience ?? 1, 0, 2);
  const industry   = clamp(g.industry   ?? 0.5, 0, 1);
  const sociability = clamp(g.sociability ?? 0.5, 0, 1);
  const aggression = clamp(g.aggression ?? 0.3, 0, 1);
  const risk       = clamp(g.risk       ?? 0.5, 0, 1);
  const empathy    = clamp(g.empathy    ?? 0.5, 0, 1);
  const curiosity  = clamp(g.curiosity  ?? 0.5, 0, 1);

  const I  = clamp(ev.intensity ?? 0.4, 0, 1);
  const gc = clamp(ev.goalCongruence ?? 0, -1, 1);

  const bump = (k, v) => {
    if (v === 0) return;
    a.e[k] = clamp(a.e[k] + v, 0, 1);
  };

  // ── Goal congruence ─────────────────────────────────────────────────────
  if (gc > 0) {
    bump('joy', gc * I * W.joy);
    if (ev.agency === 'self') {
      bump('pride', gc * I * (W.prideSelf + industry * (1 - W.prideSelf)));
    }
    if (ev.social) {
      bump('trust', gc * I * (W.trustSocial + sociability * (1 - W.trustSocial)));
    }
    // Unexpected good news still raises a little anticipation
    if (ev.certainty !== undefined && ev.certainty < 0.6) {
      bump('anticipation', I * W.anticipationLowCertainty);
    }
  } else if (gc < 0) {
    const hurt = -gc * I;
    const resFactor = 1 - clamp(resilience / 1.5, 0, 1);
    bump('sadness', hurt * (W.sadnessBase + resFactor * W.sadnessResilience));

    if (ev.agency === 'other') {
      bump('anger', hurt * (W.angerOther + aggression * W.angerAggression));
    } else if (ev.agency === 'self') {
      bump('shame', hurt * (W.shameSelf + (1 - risk) * W.shameRisk));
    } else if (ev.agency === 'world') {
      bump('fear', hurt * (W.fearWorld + (1 - risk) * W.fearRisk));
    }

    if ((ev.certainty ?? 1) < 0.5) {
      bump('fear', hurt * W.fearUncertainty);
    }
  }

  // ── Novelty ─────────────────────────────────────────────────────────────
  if (ev.novelty) {
    const nov = clamp(ev.novelty, 0, 1);
    bump('surprise', nov * I * W.surprise);
    if (nov > 0.7) {
      bump('awe', nov * I * (W.aweNovelty + curiosity * W.aweCuriosity));
    }
  }

  // ── Normative appraisal ─────────────────────────────────────────────────
  if (ev.norm !== undefined) {
    const n = clamp(ev.norm, -1, 1);
    if (n < 0) {
      const moral = -n * I * (W.normShameAnger + empathy * W.normEmpathy);
      bump(ev.agency === 'self' ? 'shame' : 'anger', moral);
      bump('disgust', -n * I * W.disgustNorm);
    } else {
      bump('pride', n * I * W.prideNorm);
    }
  }

  // ── Kind-specific ───────────────────────────────────────────────────────
  if (ev.kind === 'death' && ev.social) {
    bump('grief', I * (0.5 + empathy * W.griefEmpathy));
  }
  if (ev.kind === 'bond') {
    bump('love', I * (0.5 + empathy * W.loveEmpathy));
  }
  if (ev.kind === 'alone') {
    bump('loneliness', I * sociability * W.lonelinessSociability);
  }

  // ── Core affect dimensions ──────────────────────────────────────────────
  a.valence = clamp(lerp(a.valence, gc, 0.35 * I + 0.05), -1, 1);
  a.arousal = clamp(lerp(a.arousal, I, 0.4), 0, 1);

  return a;
}

/**
 * Emotions cool off; mood is the slow-moving average that colours everything.
 * Grief and love decay more slowly (persistent).
 */
export function decayAffect(agent, dt = 1) {
  const a = agent.affect;
  const resilience = clamp(agent.genome.resilience ?? 1, 0.2, 2);
  const rate = clamp(0.035 * dt * resilience, 0, 0.6);

  for (const k of EMOTIONS) {
    const factor = PERSISTENT.has(k) ? PERSISTENCE_FACTOR : 1;
    a.e[k] = a.e[k] * (1 - rate * factor);
    // Micro-prune noise floor
    if (a.e[k] < 0.008) a.e[k] = 0;
  }

  a.arousal = clamp(a.arousal - 0.02 * dt, 0.05, 1);
  a.mood = clamp(lerp(a.mood, a.valence, 0.02 * dt), -1, 1);
}

/**
 * Strongest discrete emotion above a quiet threshold; otherwise 'calm'.
 */
export function dominantEmotion(agent, threshold = 0.12) {
  let best = 'calm';
  let bv = threshold;
  for (const k of EMOTIONS) {
    const v = agent.affect.e[k];
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

/**
 * How feelings bias choice. Returns multipliers applied to action utilities.
 * Every value is clamped to ≥ BIAS_FLOOR so utilities never invert sign.
 */
export function emotionalBias(agent) {
  const e = agent.affect.e;
  const ar = agent.affect.arousal;

  // Mild arousal amplification: high arousal pushes extremes further from 1
  const amp = 1 + (ar - 0.3) * 0.25;

  const b = (v) => Math.max(BIAS_FLOOR, 1 + (v - 1) * amp);

  return {
    explore: b(1 + e.anticipation * 0.6 + e.awe * 0.4 - e.fear * 0.7 - e.sadness * 0.3),
    social:  b(1 + e.loneliness * 0.9 + e.love * 0.7 + e.trust * 0.4 - e.anger * 0.3 - e.shame * 0.5),
    work:    b(1 + e.pride * 0.5 + e.anticipation * 0.3 - e.sadness * 0.6 - e.grief * 0.5),
    aggress: b(1 + e.anger * 1.4 + e.disgust * 0.5 - e.fear * 0.6 - e.love * 0.4),
    rest:    b(1 + e.sadness * 0.7 + e.grief * 0.8 + e.fear * 0.3),
    create:  b(1 + e.awe * 0.9 + e.pride * 0.5 + e.grief * 0.4 + e.love * 0.3),
    hoard:   b(1 + e.fear * 0.8 + e.sadness * 0.2),
  };
}

export const MOOD_WORDS = [
  [-0.7, 'despairing'],
  [-0.45, 'wretched'],
  [-0.2, 'low'],
  [-0.05, 'uneasy'],
  [0.08, 'settled'],
  [0.3, 'content'],
  [0.55, 'glad'],
  [1.01, 'exultant'], // 1.01 so the final clamp(1) still hits this bucket
];

export function moodWord(v) {
  const x = clamp(v, -1, 1);
  for (const [t, w] of MOOD_WORDS) {
    if (x <= t) return w;
  }
  return 'exultant';
}
