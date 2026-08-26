// Everything an inhabitant can choose to do. Each action proposes itself with a
// utility derived from the agent's own body, feelings, beliefs and relationships,
// so behaviour is never scripted — it is argued for, and the strongest argument
// (with some temperament-driven noise) wins.
//
// Norms enter here only as learned beliefs (via sim.effectiveNorm / personalNorm).
// Nothing is forbidden because a constant said so.

import { clamp, dist, topN } from '../core/util.js';
import { TERRAIN } from '../world/world.js';
import { appraise } from './emotion.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const T = (x, y) => ({ x, y });

function stepToward(agent, world, target) {
  const dx = Math.sign(target.x - agent.x);
  const dy = Math.sign(target.y - agent.y);
  if (dx === 0 && dy === 0) return true;

  const tries = [
    T(agent.x + dx, agent.y + dy),
    T(agent.x + dx, agent.y),
    T(agent.x, agent.y + dy),
    T(agent.x + dx, agent.y - dy),
    T(agent.x - dx, agent.y + dy),
  ];

  for (const t of tries) {
    if (world.walkable(t.x, t.y)) {
      agent.x = t.x;
      agent.y = t.y;
      agent.stats.steps++;
      const idx = world.idx(t.x, t.y);
      world.trails[idx] = clamp(world.trails[idx] + 0.02, 0, 1);
      return agent.x === target.x && agent.y === target.y;
    }
  }
  return false;
}

function nearWater(world, agent, radius = 14) {
  let best = null;
  let bd = Infinity;
  const y0 = Math.max(0, agent.y - radius);
  const y1 = Math.min(world.h - 1, agent.y + radius);
  const x0 = Math.max(0, agent.x - radius);
  const x1 = Math.min(world.w - 1, agent.x + radius);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const terrain = world.at(x, y);
      if (terrain !== TERRAIN.WATER && terrain !== TERRAIN.MARSH) continue;
      const d = (x - agent.x) ** 2 + (y - agent.y) ** 2;
      if (d < bd) {
        bd = d;
        best = T(x, y);
      }
    }
  }
  return best;
}

function beside(world, t) {
  for (const [ox, oy] of [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ]) {
    if (world.walkable(t.x + ox, t.y + oy)) return T(t.x + ox, t.y + oy);
  }
  return t;
}

/**
 * Norm pressure in roughly [-1, 1] from the agent's own beliefs + population climate.
 * Falls back safely if sim helpers are missing.
 */
function normPull(a, ctx, key) {
  if (typeof ctx.sim.effectiveNorm === 'function') {
    return ctx.sim.effectiveNorm(a, key);
  }
  if (typeof ctx.sim.personalNorm === 'function') {
    return ctx.sim.personalNorm(a, key);
  }
  // Legacy: society strength only (signed negative for prohibitions)
  const s = ctx.sim.normStrength?.(key) || 0;
  return -s;
}

const U = {
  thirstBase: 2.6,
  thirstCrisis: 6,
  hungerBase: 3,
  hungerCrisis: 16,
  sleepNeed: 1.7,
  warmth: 3.2,
  idle: 0.08,
};

const STRUCTURE_KINDS = {
  shelter:  { fn: 'shelter',    cost: 6,  need: (s) => s.shelterDeficit,  desc: 'a place to sleep out of the weather' },
  hearth:   { fn: 'heat',       cost: 4,  need: (s) => s.hearthDeficit,   desc: 'a fire that does not go out' },
  store:    { fn: 'storage',    cost: 7,  need: (s) => s.storeDeficit,    desc: 'somewhere to keep food for winter' },
  workshop: { fn: 'cutting',    cost: 9,  need: (s) => s.workshopDeficit, desc: 'a place to make things properly' },
  field:    { fn: 'sustenance', cost: 5,  need: (s) => s.fieldDeficit,    desc: 'ground turned for planted grain' },
  well:     { fn: 'vessel',     cost: 8,  need: (s) => s.wellDeficit,     desc: 'water that does not need a walk' },
  shrine:   { fn: 'art',        cost: 6,  need: (s) => s.shrineDeficit,   desc: 'a place for the dead and the questions' },
  wall:     { fn: 'shelter',    cost: 14, need: (s) => s.wallDeficit,     desc: 'a boundary against what is out there' },
  hall:     { fn: 'shelter',    cost: 18, need: (s) => s.hallDeficit,     desc: 'one roof big enough for everyone' },
};

export const ACTIONS = {
  // ── survival ──────────────────────────────────────────────────────────────

  drink: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.thirst < 0.28) return [];
      const own = a.count('water');
      const spot = own > 0
        ? null
        : (nearWater(ctx.world, a, 12) || ctx.world.nearestWater?.(a.x, a.y));
      const well = ctx.world.structuresOfKind('well')[0];
      const target = own > 0
        ? T(a.x, a.y)
        : (well && dist(a, well) < 10
            ? well
            : spot
              ? beside(ctx.world, spot)
              : null);
      if (!target) return [];
      const u =
        a.body.thirst * U.thirstBase +
        Math.max(0, a.body.thirst - 0.6) * U.thirstCrisis;
      return [{ kind: 'drink', u, target, dur: 1 }];
    },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) {
        return 'continue';
      }
      if (a.count('water') > 0) a.take('water', 1);
      a.body.thirst = clamp(a.body.thirst - 0.75, 0, 1);
      appraise(a, {
        goalCongruence: 0.35,
        agency: 'self',
        intensity: 0.25,
        kind: 'drink',
      });
      return 'done';
    },
  },

  eat: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.hunger < 0.3) return [];
      let best = null;
      for (const key of a.inventory.keys()) {
        const c = ctx.ont.get(key);
        const n = c?.serves('sustenance') || 0;
        if (n > (best?.n || 0)) best = { key, n, c };
      }
      if (!best) {
        const store = ctx.world
          .structuresOfKind('store')
          .find((s) => s.stock && [...s.stock.values()].some((v) => v > 0));
        if (store) {
          return [{
            kind: 'takeFromStore',
            u:
              a.body.hunger * U.hungerBase +
              Math.max(0, a.body.hunger - 0.45) * 10,
            target: store,
            dur: 1,
          }];
        }
        return [];
      }
      const u =
        (a.body.hunger * U.hungerBase +
          Math.max(0, a.body.hunger - 0.45) * U.hungerCrisis) *
        (0.5 + best.n);
      return [{ kind: 'eat', u, payload: best.key, dur: 1 }];
    },
    run(a, ctx, act) {
      const c = ctx.ont.get(act.payload);
      if (!c || !a.take(act.payload, 1)) return 'abort';
      const nutrition = c.serves('sustenance');
      a.body.hunger = clamp(a.body.hunger - 0.34 - nutrition * 0.6, 0, 1);

      if (c.props?.toxic > 0.2 && ctx.rng.bool(c.props.toxic * 0.5)) {
        a.body.illness = clamp(a.body.illness + c.props.toxic * 0.5, 0, 1);
        ctx.sim.record(a, 'illness', `${a.name} sickened after eating ${c.word}`, {
          valence: -0.6,
          intensity: 0.6,
          concept: act.payload,
        });
        a.memory.learn(act.payload, {
          kind: 'concept',
          confidence: 0.5,
          valence: -0.7,
          source: 'suffering',
        });
      } else {
        a.memory.learn(act.payload, {
          kind: 'concept',
          confidence: 0.35,
          valence: 0.5,
          source: 'experience',
        });
      }
      a.stats.meals++;
      appraise(a, {
        goalCongruence: 0.5,
        agency: 'self',
        intensity: 0.35,
        kind: 'eat',
        concept: act.payload,
      });
      return 'done';
    },
  },

  takeFromStore: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.hunger < 0.45) return [];
      const store = ctx.world
        .structuresOfKind('store')
        .find((s) => s.stock && [...s.stock.values()].some((v) => v > 0));
      if (!store) return [];
      return [{
        kind: 'takeFromStore',
        u: a.body.hunger * 1.8,
        target: store,
        dur: 1,
      }];
    },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) {
        return 'continue';
      }
      const s = act.target;
      if (!s?.stock) return 'abort';
      for (const [k, v] of s.stock) {
        if (v > 0) {
          s.stock.set(k, v - 1);
          a.add(k, 1);
          ctx.sim.record(
            a,
            'store',
            `${a.name} drew ${ctx.ont.get(k)?.word || k} from the ${s.word}`,
            { valence: 0.2, intensity: 0.2 },
          );
          return 'done';
        }
      }
      return 'abort';
    },
  },

  sleep: {
    category: 'body',
    propose(a, ctx) {
      const need =
        (1 - a.body.rest) +
        (ctx.world.isNight ? 0.55 : 0) +
        (1 - a.body.energy) * 0.5;
      if (need < 0.55) return [];
      const target = a.home ? T(a.home.x, a.home.y) : T(a.x, a.y);
      return [{
        kind: 'sleep',
        u: need * U.sleepNeed,
        target,
        dur: 5 + Math.round(ctx.rng.float(0, 3)),
      }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      a.body.rest = clamp(a.body.rest + 0.2, 0, 1);
      a.body.energy = clamp(a.body.energy + 0.14, 0, 1);
      const sheltered = a.home && dist(a, a.home) < 1.5;
      if (sheltered) a.body.warmth = clamp(a.body.warmth + 0.1, 0, 1);
      if (--act.dur <= 0) {
        a.memory.consolidate(a);
        return 'done';
      }
      return 'continue';
    },
  },

  seekWarmth: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.warmth > 0.42) return [];
      const hearth = topN(
        ctx.world.structuresOfKind('hearth'),
        1,
        (s) => -dist(a, s),
      )[0];
      const target = hearth || a.home;
      if (!target) return [];
      return [{
        kind: 'seekWarmth',
        u: (0.6 - a.body.warmth) * U.warmth,
        target: T(target.x, target.y),
        dur: 3,
      }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      a.body.warmth = clamp(a.body.warmth + 0.16, 0, 1);
      if (--act.dur <= 0) return 'done';
      return 'continue';
    },
  },

  // ── work (unchanged structure; omitted comments only) ───────────────────

  gather: {
    category: 'work',
    propose(a, ctx) {
      const laden = a.carried() > a.carryLimit;
      const out = [];
      const known = new Set(
        a.memory.knownKeys('matter').concat([...a.memory.semantic.keys()]),
      );
      const scored = [];
      for (const c of ctx.ont.matter()) {
        if (!(known.has(c.key) || a.genome.curiosity > 0.5)) continue;
        if (laden && !(c.functions.sustenance && a.body.hunger > 0.35)) continue;
        scored.push({ c, desire: a.desireFor(c.key, ctx.ont, ctx.sim) });
      }
      for (const { c, desire } of topN(scored, 5, (s) => s.desire)) {
        const remembered = a.memory.belief(`where:${c.key}`)?.payload;
        const spot =
          ctx.world.findResource(c.key, a, 18 + a.genome.acuity * 16) ||
          (remembered &&
          ctx.world.bedAt(remembered.x, remembered.y)?.[c.key]?.amount > 1
            ? remembered
            : null);
        if (!spot) continue;
        const travel = dist(a, spot);
        const feedsMe = c.functions.sustenance ? 1 + a.body.hunger * 2.2 : 1;
        const u =
          (desire * 1.9 * feedsMe * ctx.bias.work) /
          (1 + travel * 0.06) *
          (0.6 + a.skills.forage);
        out.push({
          kind: 'gather',
          u,
          payload: c.key,
          target: beside(ctx.world, spot),
          site: spot,
          dur: 2,
        });
      }
      return topN(out, 3, (o) => o.u);
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      const yieldAmt =
        3 + Math.floor((1.1 + a.skills.forage * 3) * ctx.rng.float(0.7, 1.5));
      const got = ctx.world.harvest(act.site.x, act.site.y, act.payload, yieldAmt);
      if (got <= 0) {
        a.memory.learn(`where:${act.payload}`, {
          kind: 'place',
          confidence: 0.2,
          valence: -0.3,
          payload: null,
        });
        return 'abort';
      }
      a.add(act.payload, got);
      a.stats.harvested += got;
      a.gainSkill('forage', 0.02);
      a.memory.learn(`where:${act.payload}`, {
        kind: 'place',
        confidence: 0.6,
        valence: 0.4,
        payload: { x: act.site.x, y: act.site.y },
      });
      a.memory.learn(act.payload, {
        kind: 'matter',
        confidence: 0.5,
        valence: 0.3,
      });
      a.memory.link(
        act.payload,
        'found-at',
        `${act.site.x},${act.site.y}`,
        0.4,
      );
      ctx.sim.record(
        a,
        'gather',
        `${a.name} gathered ${Math.round(got)} ${ctx.ont.get(act.payload)?.word || act.payload}`,
        {
          valence: 0.25,
          intensity: 0.2,
          concept: act.payload,
          quiet: true,
        },
      );
      appraise(a, {
        goalCongruence: 0.3,
        agency: 'self',
        intensity: 0.25,
        kind: 'gather',
      });
      if (--act.dur <= 0 || a.carried() > a.carryLimit) return 'done';
      return 'continue';
    },
  },

  hunt: {
    category: 'work',
    propose(a, ctx) {
      const spot = ctx.world.findResource('game', a, 12 + a.genome.acuity * 10);
      if (!spot) return [];
      const hungerPull = 0.5 + a.body.hunger * 1.6;
      const weapon = a.bestToolFor('weapon', ctx.ont);
      const capability =
        0.25 + a.skills.hunt * 0.9 + (weapon ? weapon.score * 0.9 : 0);
      const risk = clamp(0.5 - capability * 0.4);
      const u =
        (hungerPull *
          capability *
          ctx.bias.work *
          (1 - risk * (1 - a.genome.risk))) /
        (1 + dist(a, spot) * 0.05);
      return [{
        kind: 'hunt',
        u,
        target: beside(ctx.world, spot),
        site: spot,
        dur: 3,
        weapon: weapon?.key || null,
      }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';

      const weapon = act.weapon ? ctx.ont.get(act.weapon) : null;
      const power =
        0.2 +
        a.skills.hunt * 0.8 +
        (weapon ? weapon.serves('weapon') : 0) +
        a.body.energy * 0.3;
      a.body.energy = clamp(a.body.energy - 0.18, 0, 1);

      if (ctx.rng.next() < clamp(power / (power + 0.75))) {
        const got = ctx.world.harvest(
          act.site.x,
          act.site.y,
          'game',
          1 + Math.floor(power),
        );
        if (got <= 0) return 'abort';
        a.add('meat', got * 2);
        a.add('hide', got);
        a.add('bone', got);
        a.stats.harvested += got * 4;
        a.gainSkill('hunt', 0.05);
        ctx.sim.record(
          a,
          'hunt',
          `${a.name} brought down game on the ${ctx.world.season} ground`,
          { valence: 0.6, intensity: 0.6, concept: 'meat' },
        );
        appraise(a, {
          goalCongruence: 0.7,
          agency: 'self',
          intensity: 0.6,
          kind: 'hunt',
        });
        for (const k of ['meat', 'hide', 'bone']) {
          a.memory.learn(k, { kind: 'matter', confidence: 0.6, valence: 0.4 });
        }
      } else {
        const hurt =
          ctx.rng.float(0.05, 0.3) / Math.max(0.2, a.genome.resilience);
        a.body.injury = clamp(a.body.injury + hurt, 0, 1);
        const idx = ctx.world.idx(act.site.x, act.site.y);
        ctx.world.danger[idx] = clamp(ctx.world.danger[idx] + 0.3, 0, 1);
        ctx.sim.record(
          a,
          'injury',
          `${a.name} was hurt hunting and came back with nothing`,
          { valence: -0.7, intensity: 0.7 },
        );
        appraise(a, {
          goalCongruence: -0.6,
          agency: 'world',
          intensity: 0.7,
          kind: 'injury',
          certainty: 0.4,
        });
      }
      return 'done';
    },
  },

  craft: {
    category: 'work',
    propose(a, ctx) {
      if (a.carried() > a.carryLimit * 0.95) return [];
      const out = [];
      const hungryHousehold =
        a.body.hunger > 0.35 ||
        ctx.sim.totalFood() < ctx.sim.living.length * 2;
      let looked = 0;
      for (const key of a.memory.knownKeys('recipe')) {
        if (++looked > 24) break;
        const c = ctx.ont.get(key);
        if (!c) continue;
        const have = c.parents.every((p) => a.count(p) >= 1);
        if (!have) continue;
        if (
          hungryHousehold &&
          !c.functions.sustenance &&
          c.parents.some(
            (p) => (ctx.ont.get(p)?.serves('sustenance') || 0) > 0.2,
          )
        ) {
          continue;
        }
        const desire = a.desireFor(key, ctx.ont, ctx.sim);
        // Craft-respect norm gently boosts making things well
        const craftNorm = normPull(a, ctx, 'craft');
        out.push({
          kind: 'craft',
          u:
            desire *
            1.3 *
            ctx.bias.work *
            (0.5 + a.skills.craft) *
            (1 + Math.max(0, craftNorm) * 0.25),
          payload: key,
          dur: 2 + c.tier,
        });
      }
      return topN(out, 2, (o) => o.u);
    },
    run(a, ctx, act) {
      if (--act.dur > 0) return 'continue';
      const c = ctx.ont.get(act.payload);
      if (!c) return 'abort';
      for (const p of c.parents) {
        if (!a.take(p, 1)) return 'abort';
      }
      a.add(act.payload, 1);
      c.uses++;
      a.stats.crafted++;
      a.gainSkill('craft', 0.035);
      a.body.energy = clamp(a.body.energy - 0.07, 0, 1);
      ctx.sim.record(a, 'craft', `${a.name} made ${c.word}`, {
        valence: 0.4,
        intensity: 0.35,
        concept: c.key,
        quiet: true,
      });
      appraise(a, {
        goalCongruence: 0.45,
        agency: 'self',
        intensity: 0.4,
        kind: 'craft',
      });
      return 'done';
    },
  },

  experiment: {
    category: 'thought',
    propose(a, ctx) {
      if (a.body.hunger > 0.72 || a.body.energy < 0.25) return [];
      const owned = [...a.inventory.keys()].filter((k) => ctx.ont.get(k));
      if (owned.length < 1) return [];
      const u =
        (0.55 + a.genome.curiosity * 1.9) *
        ctx.bias.explore *
        (0.7 + a.skills.craft) *
        (1 - a.body.hunger * 0.5) *
        (a.affect.e.awe * 0.5 + 0.95) *
        (1 + ctx.sim.capabilityGaps(a).length * 0.12);
      return [{
        kind: 'experiment',
        u,
        dur: 2 + Math.round((1 - a.genome.patience) * 2),
      }];
    },
    run(a, ctx, act) {
      if (--act.dur > 0) return 'continue';
      const owned = [...a.inventory.keys()].filter((k) => ctx.ont.get(k));
      if (!owned.length) return 'abort';
      const procs = ctx.ont.availableProcesses();
      const gaps = ctx.sim.capabilityGaps(a);
      const short =
        a.body.hunger > 0.35 ||
        ctx.sim.totalFood() < ctx.sim.living.length * 2;

      const weight = (k) => {
        const c = ctx.ont.get(k);
        let w = 0.3 + (a.memory.belief(k)?.confidence || 0) * 0.6;
        if (short && c.serves('sustenance') > 0.2) w *= 0.08;
        for (const g of gaps) {
          w +=
            (c.functions[g] || 0) * 1.5 +
            (c.props.hard + c.props.flexible) * 0.1;
        }
        return w;
      };

      const aKey = ctx.rng.weighted(owned.map((k) => [k, weight(k)]));
      const bKey = ctx.rng.bool(0.78)
        ? ctx.rng.weighted(owned.map((k) => [k, weight(k)]))
        : null;
      const proc = ctx.rng.weighted(
        procs.map((p) => [
          p,
          1 + (a.memory.belief(`proc:${p}`)?.confidence || 0) * 1.5,
        ]),
      );
      a.memory.learn(`proc:${proc}`, {
        kind: 'process',
        confidence: 0.08,
        valence: 0,
      });

      const res = ctx.ont.attempt(
        a,
        aKey,
        bKey && bKey !== aKey ? bKey : null,
        proc,
      );
      a.stats.ideas++;
      a.body.energy = clamp(a.body.energy - 0.06, 0, 1);
      a.gainSkill('craft', 0.02);

      if (!res.ok) {
        if (res.reason === 'known' && res.concept) {
          a.memory.learn(res.concept.key, {
            kind: 'recipe',
            confidence: 0.5,
            valence: 0.2,
            source: 'rediscovery',
          });
        } else {
          appraise(a, {
            goalCongruence: -0.15,
            agency: 'self',
            intensity: 0.2,
            kind: 'failure',
          });
        }
        return 'done';
      }

      const c = res.concept;
      for (const p of c.parents) a.take(p, 1);
      a.add(c.key, 1);
      a.memory.learn(c.key, {
        kind: 'recipe',
        confidence: 0.85,
        valence: 0.7,
        source: 'invention',
      });
      for (const p of c.parents) {
        a.memory.link(p, 'combines-into', c.key, 0.6);
      }
      a.memory.link(c.key, 'serves', c.bestFn, 0.7);
      a.stats.inventions++;
      a.gainSkill('craft', 0.05);
      const proud = res.advance ? 0.95 : 0.35;
      appraise(a, {
        goalCongruence: proud,
        agency: 'self',
        intensity: proud,
        novelty: 1,
        kind: 'invention',
      });
      ctx.sim.onInvention(a, res.record, c);
      return 'done';
    },
  },

  build: {
    category: 'work',
    propose(a, ctx) {
      if (a.isChild(ctx.world.tick)) return [];
      const settlement = ctx.sim.nearestSettlement(a.x, a.y);
      const s = ctx.sim
