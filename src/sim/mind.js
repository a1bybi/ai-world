// One mind, one tick. Perceive → feel → weigh every option → act.
// The agent's own reasoning is kept on `agent.reasoning` so an observer can open
// anybody's head and see exactly why they did what they did.

// One mind, one tick. Perceive → feel → weigh every option → act.
// The agent's own reasoning is kept on `agent.reasoning` so an observer can open
// anybody's head and see exactly why they did what they did.

import { clamp, softmaxPick, topN } from '../core/util.js';
import { ACTIONS } from './actions.js';
import { decayAffect, emotionalBias, appraise, dominantEmotion } from './emotion.js';

const ACTION_LIST = Object.entries(ACTIONS);

export function updateBody(a, world, dt = 1) {
  const b = a.body;
  const g = a.genome;
  const cold = clamp(0.62 - world.temperature) * (world.isNight ? 1.5 : 1);
  const clothing = a.bestClothing || 0;
  const young = a.ageAt(world.tick) < 12 ? 0.55 : 1;   // small bodies, small appetites
  b.hunger = clamp(b.hunger + 0.0105 * g.metabolism * young * dt, 0, 1);
  b.thirst = clamp(b.thirst + 0.016 * dt, 0, 1);
  b.rest = clamp(b.rest - 0.0092 * dt, 0, 1);
  b.energy = clamp(b.energy - 0.007 * dt + (b.rest > 0.6 ? 0.007 : 0), 0, 1);
  b.warmth = clamp(b.warmth - cold * 0.035 * dt * (1 - clothing * 0.7) + 0.022 * dt, 0, 1);

  let damage = 0;
  if (b.hunger > 0.9) damage += (b.hunger - 0.9) * 0.055;
  if (b.thirst > 0.9) damage += (b.thirst - 0.9) * 0.14;
  if (b.warmth < 0.18) damage += (0.18 - b.warmth) * 0.09;
  if (b.rest < 0.06) damage += 0.005;
  damage += b.illness * 0.02 + b.injury * 0.015;
  damage /= g.resilience;
  const mend = 0.007 * clamp(1 - b.hunger * 1.1) * clamp(1 - b.illness - b.injury) * g.resilience;
  b.health = clamp(b.health - damage * dt + mend * dt, 0, 1);
  b.illness = clamp(b.illness - 0.004 * g.resilience * dt, 0, 1);
  b.injury = clamp(b.injury - 0.004 * g.resilience * dt, 0, 1);

  // Old age tells.
  const age = a.ageAt(world.tick);
  const span = 62 * g.longevity;
  if (age > span * 0.75) b.health = clamp(b.health - 0.0006 * (age - span * 0.75) * dt, 0, 1);
}

function computeClothing(a, ont) {
  let best = 0;
  for (const k of a.inventory.keys()) {
    const c = ont.get(k);
    if (c) best = Math.max(best, c.serves('clothing'));
  }
  a.bestClothing = clamp(best);
}

export function think(a, ctx) {
  const { world } = ctx;
  a.worldTick = world.tick;
  computeClothing(a, ctx.ont);
  updateBody(a, world);
  decayAffect(a);
  if ((world.tick + a.seq) % 8 === 0) a.memory.fade(0.012);

  // Perception: who is near, and what that does to us.
  const near = ctx.nearby(a, 7).filter((o) => o.id !== a.id);
  for (const o of near) {
    const r = a.rel(o);
    r.familiarity = clamp(r.familiarity + 0.006);
    r.lastSeen = world.tick;
  }
  if (!near.length && a.genome.sociability > 0.5 && world.tick % 6 === 0) {
    appraise(a, { goalCongruence: -0.2, agency: 'world', intensity: a.genome.sociability * 0.5, kind: 'alone' });
  }

  ctx.bias = emotionalBias(a);

  // Continue what we were doing, unless something urgent overrides it.
  if (a.action) {
    const urgent = a.body.thirst > 0.9 || a.body.hunger > 0.92 || a.body.health < 0.3;
    if (!urgent || a.action.kind === 'eat' || a.action.kind === 'drink') {
      const res = ACTIONS[a.action.kind].run(a, ctx, a.action);
      if (res === 'continue') return;
      a.lastAction = a.action.kind;
      a.action = null;
      if (res === 'abort') a.frustration = (a.frustration || 0) + 1;
      else a.frustration = 0;
      return;
    }
    a.action = null;
  }

  // Deliberate. Every action argues for itself; feelings tip the scales.
  // A body in trouble narrows the mind. Philosophy waits for the thirst to pass.
  const deficits = {
    food: (a.body.hunger - 0.5) / 0.5,
    water: (a.body.thirst - 0.5) / 0.5,
    warm: (0.3 - a.body.warmth) / 0.3,
    tired: (0.25 - a.body.rest) / 0.25,
    hurt: (0.4 - a.body.health) / 0.4,
  };
  let worst = null, crisis = 0;
  for (const [k, v] of Object.entries(deficits)) if (v > crisis) { crisis = v; worst = k; }
  crisis = clamp(crisis);
  const FEEDS = new Set(['gather', 'hunt', 'farm', 'takeFromStore']);
  const RELIEF = { eat: 'food', takeFromStore: 'food', drink: 'water', seekWarmth: 'warm', sleep: 'tired', care: 'hurt' };

  const candidates = [];
  for (const [name, def] of ACTION_LIST) {
    let props;
    try { props = def.propose(a, ctx) || []; } catch (e) { props = []; }
    for (const p of props) {
      if (!p.kind) p.kind = name;
      // Children are not capable of everything, and know it.
      if (a.isChild(world.tick) && ['build', 'trade', 'court', 'fight', 'hunt'].includes(p.kind)) p.u *= 0.15;
      if (a.isElder(world.tick) && ['hunt', 'fight', 'build'].includes(p.kind)) p.u *= 0.5;
      if (a.isElder(world.tick) && ['teach', 'ritual', 'makeArt'].includes(p.kind)) p.u *= 1.6;
      if (a.frustration > 2 && p.kind === a.lastAction) p.u *= 0.5;
      p.u *= 1 + (a.skills[SKILL_FOR[p.kind]] || 0) * 0.25;
      if (crisis > 0) {
        if (RELIEF[p.kind] === worst) p.u *= 1 + crisis * 2.6;
        else if (RELIEF[p.kind]) p.u *= 1 + crisis * 0.4;
        else if (FEEDS.has(p.kind) && worst === 'food') p.u *= 1 + crisis * 1.4;
        else p.u *= 1 - crisis * 0.8;
      }
      candidates.push(p);
    }
  }
  if (!candidates.length) { a.action = { kind: 'idle', dur: 1 }; return; }

  const temperature = 0.16 + a.genome.curiosity * 0.3 + (1 - a.genome.patience) * 0.16;
  const chosen = softmaxPick(ctx.rng, candidates, (c) => c.u, temperature);
  a.reasoning = topN(candidates, 4, (c) => c.u).map((c) => ({ kind: c.kind, u: +c.u.toFixed(2), why: reasonFor(a, c, ctx) }));
  a.action = chosen;
  a.goal = describeGoal(a, chosen, ctx);
  if (a.genome.expressive > 0.45 && ctx.rng.bool(0.05 + a.genome.expressive * 0.06)) {
    ctx.sim.voiceThought(a, chosen);
  }
}

const SKILL_FOR = {
  gather: 'forage', hunt: 'hunt', craft: 'craft', build: 'build', farm: 'farm',
  converse: 'speak', teach: 'teach', trade: 'trade', fight: 'fight', care: 'heal',
  makeArt: 'art', experiment: 'craft',
};

function reasonFor(a, c, ctx) {
  const b = a.body;
  switch (c.kind) {
    case 'drink': return `thirst at ${Math.round(b.thirst * 100)}%`;
    case 'eat': return `hunger at ${Math.round(b.hunger * 100)}%`;
    case 'sleep': return `rest at ${Math.round(b.rest * 100)}%${ctx.world.isNight ? ', and it is dark' : ''}`;
    case 'seekWarmth': return `warmth at ${Math.round(b.warmth * 100)}%`;
    case 'gather': return `wants ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'hunt': return 'meat is worth the risk';
    case 'craft': return `knows how to make ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'experiment': return 'has a hunch about what these might become';
    case 'build': return `the settlement lacks ${c.payload.structure}`;
    case 'farm': return 'the field needs hands';
    case 'store': return 'winter is a fact';
    case 'converse': return `curious about ${ctx.sim.byId(c.targetId)?.name}`;
    case 'teach': return `${ctx.sim.byId(c.targetId)?.name} does not know this yet`;
    case 'trade': return `believes the exchange favours them (+${c.deal?.gain.toFixed(2)})`;
    case 'give': return `${ctx.sim.byId(c.targetId)?.name} is suffering`;
    case 'steal': return 'desperation outweighs conscience';
    case 'court': return `feels something for ${ctx.sim.byId(c.targetId)?.name}`;
    case 'fight': return `anger at ${ctx.sim.byId(c.targetId)?.name}`;
    case 'care': return `${ctx.sim.byId(c.targetId)?.name} is hurt`;
    case 'bury': return 'the dead should not lie in the open';
    case 'ritual': return 'grief and awe need somewhere to go';
    case 'makeArt': return 'has something to say that words will not hold';
    case 'explore': return 'does not know what is over there';
    default: return 'nothing pressing';
  }
}

function describeGoal(a, c, ctx) {
  const name = (id) => ctx.sim.byId(id)?.name || 'someone';
  switch (c.kind) {
    case 'gather': return `gathering ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'craft': return `making ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'build': return `building ${c.payload.structure}`;
    case 'experiment': return 'experimenting';
    case 'converse': return `talking with ${name(c.targetId)}`;
    case 'teach': return `teaching ${name(c.targetId)}`;
    case 'trade': return `trading with ${name(c.targetId)}`;
    case 'give': return `helping ${name(c.targetId)}`;
    case 'steal': return `stealing from ${name(c.targetId)}`;
    case 'court': return `courting ${name(c.targetId)}`;
    case 'fight': return `fighting ${name(c.targetId)}`;
    case 'care': return `tending ${name(c.targetId)}`;
    case 'bury': return 'burying the dead';
    case 'ritual': return 'at the shrine';
    case 'makeArt': return 'making something beautiful';
    case 'explore': return 'exploring';
    case 'sleep': return 'sleeping';
    case 'eat': return 'eating';
    case 'drink': return 'drinking';
    case 'farm': return 'working the field';
    case 'store': return 'storing food';
    case 'seekWarmth': return 'seeking warmth';
    default: return 'idling';
  }
}

export { dominantEmotion };
