// Appraisal-theoretic emotion. Nothing sets "anger = 0.7" directly; emotions are
// derived from how an event was appraised relative to the agent's own goals,
// then they feed back into what the agent decides to do and what it remembers.

import { clamp, lerp } from '../core/util.js';

export const EMOTIONS = [
  'joy', 'sadness', 'fear', 'anger', 'disgust', 'surprise',
  'trust', 'anticipation', 'pride', 'shame', 'grief', 'love', 'awe', 'loneliness',
];

export function blankAffect() {
  const e = {};
  for (const k of EMOTIONS) e[k] = 0;
  return { e, valence: 0, arousal: 0.2, mood: 0 };
}

/**
 * appraise(agent, ev)
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
 */
export function appraise(agent, ev) {
  const a = agent.affect;
  const g = agent.genome;
  const I = clamp(ev.intensity ?? 0.4, 0, 1);
  const gc = clamp(ev.goalCongruence ?? 0, -1, 1);
  const bump = (k, v) => { a.e[k] = clamp(a.e[k] + v, 0, 1); };

  if (gc > 0) {
    bump('joy', gc * I);
    if (ev.agency === 'self') bump('pride', gc * I * (0.5 + g.industry * 0.5));
    if (ev.social) bump('trust', gc * I * (0.4 + g.sociability * 0.6));
    if (ev.certainty !== undefined && ev.certainty < 0.6) bump('anticipation', I * 0.4);
  } else if (gc < 0) {
    const hurt = -gc * I;
    bump('sadness', hurt * (0.6 + (1 - g.resilience / 1.5) * 0.4));
    if (ev.agency === 'other') bump('anger', hurt * (0.35 + g.aggression * 0.85));
    if (ev.agency === 'self') bump('shame', hurt * (0.3 + (1 - g.risk) * 0.5));
    if (ev.agency === 'world') bump('fear', hurt * (0.4 + (1 - g.risk) * 0.7));
    if ((ev.certainty ?? 1) < 0.5) bump('fear', hurt * 0.4);
  }
  if (ev.novelty) { bump('surprise', ev.novelty * I); if (ev.novelty > 0.7) bump('awe', ev.novelty * I * (0.3 + g.curiosity * 0.7)); }
  if (ev.norm !== undefined) {
    if (ev.norm < 0) { bump(ev.agency === 'self' ? 'shame' : 'anger', -ev.norm * I * (0.4 + g.empathy * 0.6)); bump('disgust', -ev.norm * I * 0.4); }
    else bump('pride', ev.norm * I * 0.3);
  }
  if (ev.kind === 'death' && ev.social) bump('grief', I * (0.5 + g.empathy * 0.6));
  if (ev.kind === 'bond') bump('love', I * (0.5 + g.empathy * 0.5));
  if (ev.kind === 'alone') bump('loneliness', I * g.sociability);

  a.valence = clamp(lerp(a.valence, gc, 0.35 * I + 0.05), -1, 1);
  a.arousal = clamp(lerp(a.arousal, I, 0.4), 0, 1);
  return a;
}

/** Emotions cool off; mood is the slow-moving average that colours everything. */
export function decayAffect(agent, dt = 1) {
  const a = agent.affect;
  const resilience = agent.genome.resilience;
  const rate = clamp(0.035 * dt * resilience, 0, 0.6);
  for (const k of EMOTIONS) {
    const persistent = (k === 'grief' || k === 'love') ? 0.18 : 1;
    a.e[k] = clamp(a.e[k] - a.e[k] * rate * persistent, 0, 1);
  }
  a.arousal = clamp(a.arousal - 0.02 * dt, 0.05, 1);
  a.mood = clamp(lerp(a.mood, a.valence, 0.02 * dt), -1, 1);
}

export function dominantEmotion(agent) {
  let best = 'calm', bv = 0.12;
  for (const k of EMOTIONS) if (agent.affect.e[k] > bv) { bv = agent.affect.e[k]; best = k; }
  return best;
}

/** How feelings bias choice. Returns multipliers applied to action utilities. */
export function emotionalBias(agent) {
  const e = agent.affect.e;
  return {
    explore: 1 + e.anticipation * 0.6 + e.awe * 0.4 - e.fear * 0.7 - e.sadness * 0.3,
    social: 1 + e.loneliness * 0.9 + e.love * 0.7 + e.trust * 0.4 - e.anger * 0.3 - e.shame * 0.5,
    work: 1 + e.pride * 0.5 + e.anticipation * 0.3 - e.sadness * 0.6 - e.grief * 0.5,
    aggress: 1 + e.anger * 1.4 + e.disgust * 0.5 - e.fear * 0.6 - e.love * 0.4,
    rest: 1 + e.sadness * 0.7 + e.grief * 0.8 + e.fear * 0.3,
    create: 1 + e.awe * 0.9 + e.pride * 0.5 + e.grief * 0.4 + e.love * 0.3,
    hoard: 1 + e.fear * 0.8 + e.sadness * 0.2,
  };
}

export const MOOD_WORDS = [
  [-0.7, 'despairing'], [-0.45, 'wretched'], [-0.2, 'low'], [-0.05, 'uneasy'],
  [0.08, 'settled'], [0.3, 'content'], [0.55, 'glad'], [1.1, 'exultant'],
];
export function moodWord(v) {
  for (const [t, w] of MOOD_WORDS) if (v <= t) return w;
  return 'settled';
}
