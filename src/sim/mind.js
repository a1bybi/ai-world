// One mind, one tick. Perceive → feel → weigh every option → act.

import { clamp, softmaxPick, topN } from '../core/util.js';
import { ACTIONS } from './actions.js';
import { decayAffect, emotionalBias, appraise, dominantEmotion } from './emotion.js';

const ACTION_LIST = Object.entries(ACTIONS);

const SKILL_FOR = {
  gather: 'forage', hunt: 'hunt', craft: 'craft', build: 'build', farm: 'farm',
  converse: 'speak', teach: 'teach', trade: 'trade', fight: 'fight', care: 'heal',
  makeArt: 'art', experiment: 'craft',
};

const FEEDS = new Set(['gather', 'hunt', 'farm', 'takeFromStore']);
const INVEST = new Set(['build', 'store', 'expand', 'care']);

const RELIEF = {
  eat: 'food', takeFromStore: 'food', drink: 'water',
  seekWarmth: 'warm', sleep: 'tired', care: 'hurt',
};

const CHILD_RESTRICTED = new Set(['build', 'trade', 'court', 'fight', 'hunt', 'expand', 'experiment', 'craft', 'makeArt', 'steal', 'terraform']);
const ELDER_HARD = new Set(['hunt', 'fight', 'build']);
const ELDER_FAVOURED = new Set(['teach', 'ritual', 'makeArt']);

export function updateBody(a, world, dt = 1) {
  const b = a.body;
  const g = a.genome;
  const cold = clamp(0.62 - world.temperature) * (world.isNight ? 1.5 : 1);
  const clothing = a.bestClothing || 0;
  const age = a.ageAt(world.tick);
  const young = age < 12 ? 0.55 : 1;

  b.hunger = clamp(b.hunger + 0.0032 * g.metabolism * young * dt, 0, 1);
  b.thirst = clamp(b.thirst + 0.0055 * young * dt, 0, 1);
  b.rest = clamp(b.rest - 0.0075 * dt, 0, 1);
  b.energy = clamp(b.energy - 0.006 * dt + (b.rest > 0.6 ? 0.007 : 0), 0, 1);
  b.warmth = clamp(
    b.warmth - cold * 0.028 * dt * (1 - clothing * 0.7) + 0.022 * dt,
    0,
    1,
  );

  let damage = 0;
  if (b.hunger > 0.92) damage += (b.hunger - 0.92) * 0.0045;
  if (b.thirst > 0.92) damage += (b.thirst - 0.92) * 0.014;
  if (b.warmth < 0.15) damage += (0.15 - b.warmth) * 0.05;
  if (b.rest < 0.05) damage += 0.004;
  damage += b.illness * 0.02 + b.injury * 0.015;
  damage /= Math.max(0.05, g.resilience);

  const mend =
    0.007 * clamp(1 - b.hunger * 1.1) * clamp(1 - b.illness - b.injury) * g.resilience;
  b.health = clamp(b.health - damage * dt + mend * dt, 0, 1);
  b.illness = clamp(b.illness - 0.004 * g.resilience * dt, 0, 1);
  b.injury = clamp(b.injury - 0.004 * g.resilience * dt, 0, 1);

  const span = 55 * g.longevity;
  if (age > span * 0.7) {
    const t = (age - span * 0.7) / Math.max(1, span * 0.3);
    b.health = clamp(b.health - (0.001 + t * 0.004) * dt, 0, 1);
  }
  if (age > span) {
    b.health = clamp(b.health - 0.008 * dt, 0, 1);
  }
}

function computeClothing(a, ont) {
  let best = 0;
  for (const k of a.inventory.keys()) {
    const c = ont.get(k);
    if (c) best = Math.max(best, c.serves('clothing'));
  }
  a.bestClothing = clamp(best);
}

function holdingFood(a, ont) {
  for (const k of a.inventory.keys()) {
    const c = ont.get(k);
    const n = c?.serves?.('sustenance') || c?.functions?.sustenance || 0;
    if (n > 0.12) return true;
  }
  return false;
}

export function think(a, ctx) {
  const { world } = ctx;
  a.worldTick = world.tick;

  computeClothing(a, ctx.ont);
  updateBody(a, world);
  decayAffect(a);

  if ((world.tick + a.seq) % 8 === 0) {
    a.memory.fade(0.012);
    a.memory.fadeBeliefs();
  }

  a.frustration = Math.max(0, (a.frustration || 0) - 0.12);

  const near = ctx.nearby(a, 7).filter((o) => o.id !== a.id);
  for (const o of near) {
    const r = a.rel(o);
    r.familiarity = clamp(r.familiarity + 0.006);
    r.lastSeen = world.tick;
  }
  if (!near.length && a.genome.sociability > 0.5 && world.tick % 6 === 0) {
    appraise(a, {
      goalCongruence: -0.2,
      agency: 'world',
      intensity: a.genome.sociability * 0.5,
      kind: 'alone',
    });
  }

  ctx.bias = emotionalBias(a);

  if (a.action) {
    const urgent =
      a.body.thirst > 0.88 || a.body.hunger > 0.85 || a.body.health < 0.3;
    const relieving =
      a.action.kind === 'eat' ||
      a.action.kind === 'takeFromStore' ||
      a.action.kind === 'drink' ||
      a.action.kind === 'seekWarmth' ||
      a.action.kind === 'sleep' ||
      a.action.kind === 'care' ||
      a.action.kind === 'explore' ||
      a.action.kind === 'gather' ||
      a.action.kind === 'idle' ||
      ((a.action.kind === 'hunt' || a.action.kind === 'farm') && a.body.hunger > 0.55);

    if (
      a.body.hunger > 0.4 &&
      holdingFood(a, ctx.ont) &&
      a.action.kind !== 'eat' &&
      a.action.kind !== 'drink' &&
      a.action.kind !== 'takeFromStore'
    ) {
      a.action = null;
    } else if (
      a.body.thirst > 0.45 &&
      a.count('water') > 0 &&
      a.action.kind !== 'drink' &&
      a.action.kind !== 'eat'
    ) {
      a.action = null;
    } else if (!urgent || relieving) {
      let res;
      try {
        res = ACTIONS[a.action.kind].run(a, ctx, a.action);
      } catch (e) {
        res = 'abort';
        if (ctx.debug) console.warn(`[think] action ${a.action.kind} threw`, e);
      }
      if (res === 'continue') return;
      a.lastAction = a.action.kind;
      a.action = null;
      if (res === 'abort') a.frustration = (a.frustration || 0) + 1;
      else a.frustration = 0;
      return;
    } else {
      a.action = null;
    }
  }

  const deficits = {
    food: (a.body.hunger - 0.5) / 0.5,
    water: (a.body.thirst - 0.5) / 0.5,
    warm: (0.3 - a.body.warmth) / 0.3,
    tired: (0.25 - a.body.rest) / 0.25,
    hurt: (0.4 - a.body.health) / 0.4,
  };
  let worst = null;
  let crisis = 0;
  for (const [k, v] of Object.entries(deficits)) {
    if (v > crisis) {
      crisis = v;
      worst = k;
    }
  }
  crisis = clamp(crisis);

  const isChild = a.isChild(world.tick);
  const isElder = a.isElder(world.tick);
  const hungerLesson = a.memory.belief('lesson:hunger');
  const lessonWhat = hungerLesson?.payload?.what || null;

  let pairBoost = 1;
  if (!a.partner && !isChild) {
    const adults = ctx.sim.living.filter(
      (x) => !x.isChild(world.tick) && x.ageAt(world.tick) > 16,
    );
    const paired = adults.filter((x) => x.partner).length;
    if (adults.length && paired < adults.length * 0.4) pairBoost = 1.45;
  }

  const hasFood = holdingFood(a, ctx.ont);
  const worldFoodTight = ctx.sim.totalFood() < ctx.sim.living.length * 2;
  const candidates = [];

  for (const [name, def] of ACTION_LIST) {
    let props;
    try {
      props = def.propose(a, ctx) || [];
    } catch (e) {
      props = [];
      if (ctx.debug) console.warn(`[think] propose ${name} threw`, e);
    }

    for (const p of props) {
      if (!p.kind) p.kind = name;

      if (isChild && CHILD_RESTRICTED.has(p.kind)) {
        // Young children almost never invent/build; older children a little
        const age = a.ageAt(world.tick);
        p.u *= age < 10 ? 0.02 : 0.08;
      }
      if (isElder && ELDER_HARD.has(p.kind)) p.u *= 0.5;
      if (isElder && ELDER_FAVOURED.has(p.kind)) p.u *= 1.6;
      if ((a.frustration || 0) > 2 && p.kind === a.lastAction) p.u *= 0.5;

      const skillKey = SKILL_FOR[p.kind];
      if (skillKey) p.u *= 1 + (a.skills[skillKey] || 0) * 0.25;

      if (crisis > 0) {
        if (RELIEF[p.kind] === worst) p.u *= 1 + crisis * 2.6;
        else if (RELIEF[p.kind]) p.u *= 1 + crisis * 0.4;
        else if (FEEDS.has(p.kind) && worst === 'food') p.u *= 1 + crisis * 1.4;
        else if (
          p.kind === 'court' ||
          p.kind === 'converse' ||
          p.kind === 'follow'
        ) {
          p.u *= 1 - crisis * 0.12;
        } else if (INVEST.has(p.kind)) p.u *= 1 - crisis * 0.25;
        else p.u *= 1 - crisis * 0.8;
      }

      if (a.body.hunger > 0.4 && p.kind === 'eat') p.u *= 3.5;
      if (a.body.hunger > 0.4 && p.kind === 'takeFromStore') p.u *= 2.5;
      if (a.body.hunger > 0.5 && p.kind === 'gather') p.u *= 1.8;
      if (a.body.hunger > 0.5 && p.kind === 'hunt') p.u *= 1.4;
      if (a.body.thirst > 0.4 && p.kind === 'drink') p.u *= 4;
      if (
        a.body.hunger > 0.4 &&
        (p.kind === 'experiment' || p.kind === 'craft' || p.kind === 'makeArt')
      ) {
        p.u *= 0.08;
      }
      if (
        a.body.thirst > 0.5 &&
        (p.kind === 'experiment' || p.kind === 'craft' || p.kind === 'makeArt')
      ) {
        p.u *= 0.08;
      }

      if (a.body.hunger > 0.3 && hasFood) {
        if (p.kind === 'eat') p.u *= 12;
        else if (p.kind === 'drink' || p.kind === 'takeFromStore') p.u *= 1.5;
        else if (p.kind === 'store') p.u *= 2.5;
        else if (p.kind === 'build' && p.payload?.structure === 'bridge' && a.body.hunger < 0.55) p.u *= 2.0;
        else p.u *= 0.03;
      }

      if (a.body.hunger > 0.35 && !hasFood) {
        if (p.kind === 'gather' || p.kind === 'takeFromStore' || p.kind === 'farm' || p.kind === 'hunt') {
          p.u *= 3.0;
        }
        if (p.kind === 'experiment' || p.kind === 'craft' || p.kind === 'makeArt' || p.kind === 'build') {
          p.u *= 0.02;
        }
      }

      // Teaching/culture yields to survival - especially for the last adults
      if (a.body.hunger > 0.35 || a.body.thirst > 0.45) {
        if (p.kind === 'teach') p.u *= 0.02;
        if (p.kind === 'converse') p.u *= 0.15;
        if (p.kind === 'ritual' || p.kind === 'makeArt') p.u *= 0.05;
      }
      if (!isChild && a.body.hunger > 0.5) {
        if (p.kind === 'takeFromStore' || p.kind === 'eat' || p.kind === 'gather') p.u *= 2.5;
      }
      if (worldFoodTight) {
        if (p.kind === 'teach' || p.kind === 'experiment' || p.kind === 'makeArt') {
          p.u *= 0.1;
        }
        if (p.kind === 'gather' || p.kind === 'farm' || p.kind === 'takeFromStore') {
          p.u *= 2.2;
        }
      }

      if (!isChild && p.kind === 'give' && a.body.hunger < 0.55) p.u *= 2.2;

      if (
        hungerLesson &&
        hungerLesson.confidence > 0.2 &&
        worst === 'food' &&
        crisis > 0.15
      ) {
        if (p.kind === 'gather' && lessonWhat && p.payload === lessonWhat) p.u *= 1.55;
        else if (p.kind === 'eat' || p.kind === 'gather' || p.kind === 'hunt') p.u *= 1.2;
      }

      if (p.kind === 'court') p.u *= pairBoost;

      if (isChild) {
        if (p.kind === 'follow') p.u *= 3.0;
        if (p.kind === 'eat') p.u *= 5.0;
        if (p.kind === 'drink') p.u *= 4.0;
        if (p.kind === 'gather') p.u *= 2.0;
        if (p.kind === 'takeFromStore') p.u *= 2.5;
        if (p.kind === 'experiment' || p.kind === 'craft' || p.kind === 'makeArt') {
          p.u *= 0.05;
        }
        if (p.kind === 'build' || p.kind === 'expand') p.u *= 0.05;
        if (p.kind === 'bury') p.u *= 0.3;
      }

      // Civil works only when fed; starve-builders die
      if (p.kind === 'build' || p.kind === 'experiment' || p.kind === 'craft') {
        if (a.body.hunger > 0.42 || a.body.thirst > 0.5) p.u *= 0.08;
      }
      if (
        !isChild &&
        p.kind === 'build' &&
        a.body.hunger < 0.4 &&
        a.body.thirst < 0.4
      ) {
        const settle = ctx.sim.nearestSettlement?.(a.x, a.y);
        const pressure = ctx.sim.settlementPressure?.(settle) || 0;
        if (pressure > 0.12) p.u *= 1.25 + pressure;
        if (a.skills.build > 0.15 || (a.stats.built || 0) > 0) p.u *= 1.1;
      }
      if (p.kind === 'farm' || p.kind === 'gather' || p.kind === 'hunt') {
        const n = ctx.sim.living.length;
        const foodTight = ctx.sim.totalFood() < n * 3;
        if (foodTight) p.u *= p.kind === 'farm' ? 3.0 : 2.2;
        else if (a.body.hunger > 0.35 && p.kind === 'farm') p.u *= 1.6;
        // Better tools → farming/foraging pays more (inventions matter)
        if (p.kind === 'farm') {
          const sust = a.bestToolFor?.('sustenance', ctx.ont)?.score || 0;
          if (sust > 0.3) p.u *= 1 + sust * 0.6;
        }
      }
      if (p.kind === 'experiment' || p.kind === 'craft') {
        const gaps = ctx.sim.capabilityGaps?.(a) || [];
        if (gaps.length) p.u *= 1.2 + Math.min(0.5, gaps.length * 0.08);
      }
      // Expand fields when under-provisioned for population
      if (p.kind === 'build' && p.payload?.structure === 'field') {
        const n = ctx.sim.living.length;
        const fields = ctx.world.structuresOfKind('field').length;
        const want = Math.max(1, Math.min(6, Math.ceil(n / 10)));
        if (fields < want && a.body.hunger < 0.55) p.u *= 1.8 + (want - fields) * 0.35;
      }
      if (p.kind === 'build' && a.body.hunger < 0.45 && a.body.thirst < 0.45) {
        const n = ctx.sim.living.length;
        const children = ctx.sim.living.filter((x) => x.isChild?.(ctx.world.tick)).length;
        const st = p.payload?.structure;
        if (st === 'shelter') {
          const shelters = ctx.world.structuresOfKind('shelter').length;
          const want = Math.ceil(n / 1.8);
          if (shelters < want) p.u *= 1.5 + Math.min(1.2, (want - shelters) * 0.2);
          if (children > n * 0.4) p.u *= 1.35;
        }
        if (st === 'well' || st === 'hearth' || st === 'path') {
          const have = ctx.world.structuresOfKind(st).length;
          if (have < Math.ceil(n / 12)) p.u *= 1.4;
        }
      }
      if (p.kind === 'teach' || p.kind === 'trade' || p.kind === 'converse') {
        const n = ctx.sim.living.length;
        if (ctx.sim.totalFood() < n * 2.2) p.u *= 0.25;
      }
      // Fed society: endless tutoring is not the only story
      {
        const n = ctx.sim.living.length || 1;
        const foodDays = ctx.sim.foodDaysAt?.(ctx.sim.origin) ?? 99;
        const wellFed =
          a.body.hunger < 0.35 &&
          a.body.thirst < 0.35 &&
          ctx.sim.totalFood() > n * 3 &&
          foodDays > 12;
        if (wellFed) {
          if (p.kind === 'teach') {
            // Structure lessons especially dull when everyone already farms
            if (p.structureLesson || String(p.payload || '').startsWith('structure:')) {
              p.u *= 0.2;
            } else {
              p.u *= 0.55;
            }
          }
          if (p.kind === 'experiment') p.u *= 1.55;
          if (p.kind === 'craft') p.u *= 1.25;
          if (p.kind === 'makeArt' || p.kind === 'ritual') p.u *= 1.35;
          if (p.kind === 'expand') p.u *= 1.2;
          if (p.kind === 'farm' && (a.skills.farm || 0) < 0.5) p.u *= 1.15;
          if (p.kind === 'gather') p.u *= 1.2;
          if (p.kind === 'farm') p.u *= 1.25;
        }
      }
      // Skyline done: pressure is zero - invent, improve tools, or leave
      {
        const settle = ctx.sim.nearestSettlement?.(a.x, a.y);
        const pressure = ctx.sim.settlementPressure?.(settle) || 0;
        const n = ctx.sim.living.length || 1;
        const fed =
          a.body.hunger < 0.4 &&
          ctx.sim.totalFood() > n * 2.5;
        if (fed && pressure < 0.2 && a.body.energy > 0.3) {
          if (p.kind === 'experiment') p.u *= 1.8;
          if (p.kind === 'craft') p.u *= 1.35;
          if (p.kind === 'expand') p.u *= 1.5;
          if (p.kind === 'build' && !p.payload?.farFocus) p.u *= 0.55;
          if (p.kind === 'makeArt') p.u *= 1.25;
        }
      }
      if (p.kind === 'expand') {
        if (a.body.hunger > 0.38 || a.body.thirst > 0.4) p.u *= 0.05;
        else {
          const home = ctx.sim.nearestSettlement?.(a.x, a.y);
          const urge = ctx.sim.fissionUrge?.(home) || 0;
          if (urge > 0.3) p.u *= 1.4 + urge * 1.5;
          if (a.genome.risk > 0.55 || a.genome.curiosity > 0.55) p.u *= 1.2;
        }
      }
      if (p.kind === 'build' && p.payload?.farFocus) {
        if (a.body.hunger > 0.38 || a.body.thirst > 0.4) p.u *= 0.05;
        else p.u *= 1.45;
      }

      candidates.push(p);
    }
  }

  if (a.body.hunger < 0.45 && a.body.thirst < 0.45 && a.body.rest > 0.55) {
    const lonely = ctx.sim.living.length <= 2;
    for (const p of candidates) {
      if (p.kind === 'sleep') p.u *= lonely ? 0.12 : 0.3;
      if (p.kind === 'converse') p.u *= 0.65;
      if (p.kind === 'explore' || p.kind === 'gather' || p.kind === 'idle') {
        p.u *= lonely ? 2.8 : 1.8;
      }
      if (p.kind === 'makeArt' || p.kind === 'ritual') p.u *= 1.5;
    }
  }

  if (a.partner && !isChild && a.body.hunger < 0.45 && a.body.thirst < 0.45) {
    for (const p of candidates) {
      if (p.kind === 'follow') p.u *= 0.5;
      if (p.kind === 'explore') p.u = Math.max(p.u, 2.5);
      if (p.kind === 'gather') p.u *= 1.25;
    }
  }

  const home = a.home || ctx.sim.origin;
  const stagnant = (a.stats.steps || 0) < world.tick * 0.05;
  const campBound =
    home &&
    Math.hypot(a.x - home.x, a.y - home.y) < 4 &&
    (a.stats.steps || 0) < world.tick * 0.08;
  // Crowding / open bank / already far: prefer expand and river spans
  {
    const n = ctx.sim.living.length || 1;
    const home = ctx.sim.nearestSettlement?.(a.x, a.y);
    const homeD = home ? Math.hypot(a.x - home.x, a.y - home.y) : 0;
    const fission = ctx.sim.fissionUrge?.(home) || 0;
    const farBank = !!ctx.sim.farBankTarget?.(a, 30);
    if (
      a.body.hunger < 0.5 &&
      a.body.thirst < 0.5 &&
      (n >= 14 || homeD > 12 || fission > 0.2 || farBank)
    ) {
      for (const p of candidates) {
        if (p.kind === 'expand') {
          const spots = (ctx.sim._colonySpots || []).length;
          p.u = Math.max(
            p.u,
            6 + fission * 4 + (homeD > 14 ? 3 : 0) + (spots ? 5 : 0),
          );
        }
        if (p.kind === 'build' && p.payload?.structure === 'bridge' && farBank) {
          p.u = Math.max(p.u, 9);
        }
        if (p.kind === 'build' && p.payload?.farFocus) p.u *= 1.7;
        if (p.kind === 'build' && !p.payload?.farFocus && homeD < 8) p.u *= 1.1;
      }
    }
    // Young daughter camps: prioritize shelter/field/hearth over teach
    if (home && (ctx.world.tick - (home.foundedTick || 0)) < 200 && homeD < 10) {
      const age = ctx.world.tick - (home.foundedTick || 0);
      if (age > 0 && a.body.hunger < 0.55) {
        for (const p of candidates) {
          if (p.kind === 'build') p.u *= 1.45;
          if (p.kind === 'farm') p.u *= 1.25;
          if (p.kind === 'teach') p.u *= 0.55;
        }
      }
    }
  }

  // Few pairs / thin people: court before expand
  {
    const living = ctx.sim.living.length || 0;
    const pairs = ctx.sim.living.filter((x) => x.partner).length / 2;
    if (living < 24 && pairs < Math.max(2, living / 8) && a.body.hunger < 0.5) {
      for (const p of candidates) {
        if (p.kind === 'court') p.u = Math.max(p.u, 7);
        if (p.kind === 'expand') p.u *= 0.35;
      }
    }
  }

  // Pack surplus into store when granaries are empty
  {
    let food = 0;
    for (const [k, v] of a.inventory) {
      if ((ctx.ont.get(k)?.serves?.('sustenance') || 0) > 0.15) food += v;
    }
    if (food > 6 && a.body.hunger < 0.55) {
      for (const p of candidates) {
        if (p.kind === 'store') p.u = Math.max(p.u, 9);
      }
    }
  }

  // First real river span is a civil priority once the camp can eat
  {
    const home = ctx.sim.nearestSettlement?.(a.x, a.y);
    const spans = home
      ? (ctx.world.bridgeSpanCount?.(home.x, home.y, 28) || 0)
      : 0;
    if (spans === 0 && a.body.hunger < 0.5 && a.body.thirst < 0.5) {
      for (const p of candidates) {
        if (p.kind === 'build' && p.payload?.structure === 'bridge') {
          p.u = Math.max(p.u, 11);
        }
      }
    }
  }

  if ((stagnant || campBound) && a.body.hunger < 0.65 && a.body.thirst < 0.65) {
    for (const p of candidates) {
      if (p.kind === 'explore') p.u = Math.max(p.u, 11);
      if (p.kind === 'gather') p.u = Math.max(p.u, 6);
      if (p.kind === 'idle') p.u = Math.max(p.u, 3);
      if (p.kind === 'sleep') p.u *= 0.05;
      if (p.kind === 'follow') p.u *= 0.2;
      if (p.kind === 'teach' && a.body.hunger < 0.4) p.u *= 0.45;
    }
    if (!candidates.some((c) => c.kind === 'explore')) {
      const tx = clamp(a.x + ctx.rng.int(-18, 18), 1, world.w - 2);
      const ty = clamp(a.y + ctx.rng.int(-18, 18), 1, world.h - 2);
      candidates.push({
        kind: 'explore',
        u: 11,
        target: { x: tx, y: ty },
        dur: 14,
      });
    }
  }

  // Nuclear harvest: do not ignore standing grain
  {
    const ripeField = (ctx.world.structuresOfKind('field') || []).some(
      (f) => (f.ripeness || 0) >= 0.85,
    );
    if (ripeField && a.body.hunger < 0.85 && a.body.thirst < 0.85) {
      const farmCand = candidates.find((c) => c.kind === 'farm');
      if (farmCand) {
        farmCand.u = Math.max(farmCand.u, 12);
        // Prefer farm over teach/give when the fields are ready
        for (const p of candidates) {
          if (p.kind === 'teach' || p.kind === 'converse') p.u *= 0.35;
          if (p.kind === 'give' && a.body.hunger < 0.5) p.u *= 0.55;
        }
      }
    }
  }

  // Nuclear store: heavy food pack -> granary
  {
    let foodCarried = 0;
    for (const [k, v] of a.inventory) {
      if ((ctx.ont.get(k)?.serves?.('sustenance') || ctx.ont.get(k)?.functions?.sustenance || 0) > 0.15) {
        foodCarried += v;
      }
    }
    if (foodCarried > 6 && a.body.hunger < 0.5) {
      const storeCand = candidates.find((c) => c.kind === 'store');
      if (storeCand) {
        storeCand.u = Math.max(storeCand.u, 9);
      }
    }
  }

  // Nuclear eat - only when genuinely hungry
  if (a.body.hunger > 0.48 && hasFood) {
    const eatCand = candidates.find((c) => c.kind === 'eat');
    if (eatCand) {
      a.action = eatCand;
      a.noteAction?.('eat');
      a.goal = 'eating';
      a.reasoning = [{ kind: 'eat', u: eatCand.u, why: 'must eat - food in hand' }];
      if (ctx.sim.logDecision && ctx.rng.bool(0.08)) {
        ctx.sim.logDecision(a, a.reasoning, 'eating');
      }
      return;
    }
  }

  // Nuclear drink - thirst wins when sharp
  if (a.body.thirst > 0.42) {
    const drinkCand = candidates.find((c) => c.kind === 'drink');
    if (drinkCand) {
      a.action = drinkCand;
      a.noteAction?.('drink');
      a.goal = 'drinking';
      a.reasoning = [{ kind: 'drink', u: drinkCand.u, why: 'must drink - thirst first' }];
      if (ctx.sim.logDecision && ctx.rng.bool(0.08)) {
        ctx.sim.logDecision(a, a.reasoning, 'drinking');
      }
      return;
    }
  }

  // Nuclear store: granary before craft/build when hungry or thirsty
  if (a.body.hunger > 0.4 || a.body.thirst > 0.4) {
    const storeCand = candidates.find((c) => c.kind === 'takeFromStore');
    if (storeCand && (!hasFood || a.body.hunger > 0.42 || a.body.thirst > 0.42)) {
      a.action = storeCand;
      a.noteAction?.('takeFromStore');
      a.goal = 'taking from store';
      a.reasoning = [{ kind: 'takeFromStore', u: storeCand.u, why: 'store has food - before other work' }];
      if (ctx.sim.logDecision && ctx.rng.bool(0.08)) {
        ctx.sim.logDecision(a, a.reasoning, 'taking from store');
      }
      return;
    }
  }

  // Civic priorities when survival is not urgent
  if (a.body.hunger < 0.5 && a.body.thirst < 0.5) {
    let packFood = 0;
    for (const [k, v] of a.inventory) {
      if ((ctx.ont.get(k)?.serves?.('sustenance') || 0) > 0.15) packFood += v;
    }
    const storeCand2 = candidates.find((c) => c.kind === 'store');
    if (storeCand2 && packFood >= 4) storeCand2.u = Math.max(storeCand2.u, 14);
    const bridgeCand = candidates.find((c) => c.kind === 'build' && c.payload?.structure === 'bridge');
    if (bridgeCand) {
      const home = ctx.sim.nearestSettlement?.(a.x, a.y);
      const spans = home ? (ctx.world.bridgeSpanCount?.(home.x, home.y, 28) || 0) : 0;
      if (spans === 0) bridgeCand.u = Math.max(bridgeCand.u, 16);
    }
  }

  if (!candidates.length) {
    a.action = { kind: 'idle', dur: 1 };
    a.reasoning = [{ kind: 'idle', u: 0, why: 'nothing available' }];
    a.goal = 'idling';
    return;
  }

  const temperature =
    a.body.hunger > 0.45 || a.body.thirst > 0.45
      ? clamp(0.05 + a.genome.curiosity * 0.05, 0.04, 0.15)
      : crisis > 0.35
        ? clamp(0.06 + a.genome.curiosity * 0.08, 0.05, 0.2)
        : clamp(
            0.16 + a.genome.curiosity * 0.3 + (1 - a.genome.patience) * 0.16,
            0.08,
            0.75,
          );

  const chosen = softmaxPick(ctx.rng, candidates, (c) => c.u, temperature);
  a.reasoning = topN(candidates, 4, (c) => c.u).map((c) => ({
    kind: c.kind,
    u: +c.u.toFixed(2),
    why: reasonFor(a, c, ctx),
  }));
  a.action = chosen;
  if (chosen?.kind) a.noteAction?.(chosen.kind);
  a.goal = describeGoal(a, chosen, ctx);
  // Observer sample: keep a short ring of real decisions
  if (ctx.sim.logDecision && chosen && ctx.rng.bool(0.12)) {
    ctx.sim.logDecision(a, a.reasoning, a.goal);
  }

  if (
    a.genome.expressive > 0.45 &&
    ctx.rng.bool(0.05 + a.genome.expressive * 0.06)
  ) {
    ctx.sim.voiceThought(a, chosen);
  }
}

function reasonFor(a, c, ctx) {
  const b = a.body;
  const name = (id) => ctx.sim.byId(id)?.name || 'someone';
  const nPeople = ctx.sim.living?.length || 0;
  const foodTight = ctx.sim.totalFood() < nPeople * 2.8;
  const tool = (fn) => a.bestToolFor?.(fn, ctx.ont)?.score || 0;

  switch (c.kind) {
    case 'drink': return `thirst at ${Math.round(b.thirst * 100)}%`;
    case 'eat': return `hunger at ${Math.round(b.hunger * 100)}%` + (foodTight ? ', stores thin' : '');
    case 'takeFromStore':
      return foodTight
        ? 'the common store is the sure way to eat'
        : `hunger at ${Math.round(b.hunger * 100)}% - drawing from the store`;
    case 'sleep':
      return `rest at ${Math.round(b.rest * 100)}%${ctx.world.isNight ? ', and it is dark' : ''}`;
    case 'seekWarmth': return `warmth at ${Math.round(b.warmth * 100)}%`;
    case 'gather': {
      const w = ctx.ont.get(c.payload)?.word || c.payload;
      return foodTight ? `food is short - seeking ${w}` : `wants ${w}`;
    }
    case 'hunt': return 'meat is worth the risk';
    case 'craft': {
      const cnc = ctx.ont.get(c.payload);
      const fn = cnc?.bestFn;
      const tip = fn && tool(fn) > 0.3 ? ` (better ${fn} in hand)` : '';
      return `knows how to make ${cnc?.word || c.payload}${tip}`;
    }
    case 'experiment': {
      const gaps = ctx.sim.capabilityGaps?.(a) || [];
      return gaps.length
        ? `hunch toward what they lack (${gaps.slice(0, 2).join(', ')})`
        : 'has a hunch about what these might become';
    }
    case 'build': {
      const st = c.payload?.structure || 'something';
      if (c.payload?.farFocus) return `opening ${st} on the far shore`;
      return `the settlement lacks ${st}`;
    }
    case 'expand': return 'the camp is crowded; new ground may hold';
    case 'farm': {
      const sust = tool('sustenance');
      if (foodTight) return 'fields must feed them while stores are thin';
      if (sust > 0.4) return 'good tools make the field worth the day';
      return 'the field needs hands';
    }
    case 'store': return 'winter is a fact';
    case 'converse': return `curious about ${name(c.targetId)}`;
    case 'teach': return `${name(c.targetId)} does not know this yet`;
    case 'trade':
      return `believes the exchange favours them (+${c.deal?.gain?.toFixed(2) ?? '?'})`;
    case 'give': return `${name(c.targetId)} is suffering`;
    case 'steal': return 'desperation outweighs conscience';
    case 'court': return `feels something for ${name(c.targetId)}`;
    case 'fight': return `anger at ${name(c.targetId)}`;
    case 'care': return `${name(c.targetId)} is hurt`;
    case 'bury': return 'the dead should not lie in the open';
    case 'ritual': return 'grief and awe need somewhere to go';
    case 'makeArt': return 'has something to say that words will not hold';
    case 'explore': return 'does not know what is over there';
    case 'idle': return 'nothing pressing';
    default: return 'nothing pressing';
  }
}

function describeGoal(a, c, ctx) {
  const name = (id) => ctx.sim.byId(id)?.name || 'someone';
  switch (c.kind) {
    case 'gather': return `gathering ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'craft': return `making ${ctx.ont.get(c.payload)?.word || c.payload}`;
    case 'build': return `building ${c.payload?.structure || 'something'}`;
    case 'expand': return 'breaking for new ground';
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
    case 'takeFromStore': return 'drawing from the store';
    default: return 'idling';
  }
}

/**
 * Full think, or body + continue current action only (for staggered AI).
 * Urgent needs always get a full replan.
 */
export function tickAgent(a, ctx, full = true) {
  if (full) {
    think(a, ctx);
    return;
  }
  const world = ctx.world;
  updateBody(a, world);

  // Only true emergencies force a full replan on a light tick.
  // (Mild hunger is common; treating it as urgent defeated staggering.)
  const critical =
    a.body.hunger > 0.78 ||
    a.body.thirst > 0.78 ||
    a.body.health < 0.28 ||
    a.body.rest < 0.04;
  if (critical) {
    think(a, ctx);
    return;
  }

  if (a.action && ACTIONS[a.action.kind]?.run) {
    try {
      const res = ACTIONS[a.action.kind].run(a, ctx, a.action);
      if (res === 'done' || res === 'abort') {
        a.lastAction = a.action.kind;
        a.action = null;
      }
    } catch (e) {
      a.action = null;
    }
  }

  // No action and not critical: cheap placeholder until this agent is due for full think
  if (!a.action) {
    if (a.body.rest < 0.35) a.action = { kind: 'sleep', dur: 2 };
    else a.action = { kind: 'idle', dur: 2 };
  }
  decayAffect(a, 1);
}

export { dominantEmotion };

