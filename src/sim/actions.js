// Everything an inhabitant can choose to do. Each action proposes itself with a
// utility derived from the agent's own body, feelings, beliefs and relationships,
// so behaviour is never scripted — it is argued for, and the strongest argument
// (with some temperament-driven noise) wins.

import { clamp, dist, topN } from '../core/util.js';
import { TERRAIN } from '../world/world.js';
import { appraise } from './emotion.js';

const T = (x, y) => ({ x, y });

function stepToward(agent, world, target) {
  const dx = Math.sign(target.x - agent.x);
  const dy = Math.sign(target.y - agent.y);
  if (dx === 0 && dy === 0) return true;
  const tries = [T(agent.x + dx, agent.y + dy), T(agent.x + dx, agent.y), T(agent.x, agent.y + dy),
    T(agent.x + dx, agent.y - dy), T(agent.x - dx, agent.y + dy)];
  for (const t of tries) {
    if (world.walkable(t.x, t.y)) {
      agent.x = t.x; agent.y = t.y;
      agent.stats.steps++;
      world.trails[world.idx(t.x, t.y)] = clamp(world.trails[world.idx(t.x, t.y)] + 0.02, 0, 1);
      return agent.x === target.x && agent.y === target.y;
    }
  }
  return false;
}

function nearWater(world, agent, radius = 14) {
  let best = null, bd = Infinity;
  for (let y = Math.max(0, agent.y - radius); y <= Math.min(world.h - 1, agent.y + radius); y++) {
    for (let x = Math.max(0, agent.x - radius); x <= Math.min(world.w - 1, agent.x + radius); x++) {
      if (world.at(x, y) !== TERRAIN.WATER && world.at(x, y) !== TERRAIN.MARSH) continue;
      const d = (x - agent.x) ** 2 + (y - agent.y) ** 2;
      if (d < bd) { bd = d; best = T(x, y); }
    }
  }
  return best;
}

/** Adjacent walkable tile next to a target (so agents can stand beside water/rock). */
function beside(world, t) {
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    if (world.walkable(t.x + ox, t.y + oy)) return T(t.x + ox, t.y + oy);
  }
  return t;
}

const STRUCTURE_KINDS = {
  shelter:  { fn: 'shelter',  cost: 6,  need: (s) => s.shelterDeficit,   desc: 'a place to sleep out of the weather' },
  hearth:   { fn: 'heat',     cost: 4,  need: (s) => s.hearthDeficit,    desc: 'a fire that does not go out' },
  store:    { fn: 'storage',  cost: 7,  need: (s) => s.storeDeficit,     desc: 'somewhere to keep food for winter' },
  workshop: { fn: 'cutting',  cost: 9,  need: (s) => s.workshopDeficit,  desc: 'a place to make things properly' },
  field:    { fn: 'sustenance', cost: 5, need: (s) => s.fieldDeficit,    desc: 'ground turned for planted grain' },
  well:     { fn: 'vessel',   cost: 8,  need: (s) => s.wellDeficit,      desc: 'water that does not need a walk' },
  shrine:   { fn: 'art',      cost: 6,  need: (s) => s.shrineDeficit,    desc: 'a place for the dead and the questions' },
  wall:     { fn: 'shelter',  cost: 14, need: (s) => s.wallDeficit,      desc: 'a boundary against what is out there' },
  hall:     { fn: 'shelter',  cost: 18, need: (s) => s.hallDeficit,      desc: 'one roof big enough for everyone' },
};

export const ACTIONS = {
  // ── survival ──────────────────────────────────────────────────────────────
  drink: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.thirst < 0.28) return [];
      const own = a.count('water');
      const spot = own > 0 ? null : (nearWater(ctx.world, a, 12) || ctx.world.nearestWater(a.x, a.y));
      const well = ctx.world.structuresOfKind('well')[0];
      const target = own > 0 ? T(a.x, a.y) : (well && dist(a, well) < 10 ? well : spot ? beside(ctx.world, spot) : null);
      if (!target) return [];
      return [{ kind: 'drink', u: a.body.thirst * 2.6 + Math.max(0, a.body.thirst - 0.6) * 6, target, dur: 1 }];
    },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) return 'continue';
      if (a.count('water') > 0) a.take('water', 1);
      a.body.thirst = clamp(a.body.thirst - 0.75, 0, 1);
      appraise(a, { goalCongruence: 0.35, agency: 'self', intensity: 0.25, kind: 'drink' });
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
        const store = ctx.world.structuresOfKind('store').find((s) => s.stock && [...s.stock.values()].some((v) => v > 0));
        if (store) return [{ kind: 'takeFromStore', u: a.body.hunger * 3 + Math.max(0, a.body.hunger - 0.45) * 10, target: store, dur: 1 }];
        return [];
      }
      // A person with food in hand and an empty stomach eats. Nothing outbids that.
      return [{ kind: 'eat', u: (a.body.hunger * 3 + Math.max(0, a.body.hunger - 0.45) * 16) * (0.5 + best.n), payload: best.key, dur: 1 }];
    },
    run(a, ctx, act) {
      const c = ctx.ont.get(act.payload);
      if (!a.take(act.payload, 1)) return 'abort';
      const nutrition = c.serves('sustenance');
      a.body.hunger = clamp(a.body.hunger - 0.34 - nutrition * 0.6, 0, 1);
      if (c.props.toxic > 0.2 && ctx.rng.bool(c.props.toxic * 0.5)) {
        a.body.illness = clamp(a.body.illness + c.props.toxic * 0.5);
        ctx.sim.record(a, 'illness', `${a.name} sickened after eating ${c.word}`, { valence: -0.6, intensity: 0.6, concept: act.payload });
        a.memory.learn(act.payload, { kind: 'concept', confidence: 0.5, valence: -0.7, source: 'suffering' });
      } else {
        a.memory.learn(act.payload, { kind: 'concept', confidence: 0.35, valence: 0.5, source: 'experience' });
      }
      a.stats.meals++;
      appraise(a, { goalCongruence: 0.5, agency: 'self', intensity: 0.35, kind: 'eat', concept: act.payload });
      return 'done';
    },
  },

  takeFromStore: {
    category: 'body',
    propose() { return []; },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) return 'continue';
      const s = act.target;
      for (const [k, v] of s.stock) {
        if (v > 0) { s.stock.set(k, v - 1); a.add(k, 1); ctx.sim.record(a, 'store', `${a.name} drew ${ctx.ont.get(k)?.word || k} from the ${s.word}`, { valence: 0.2, intensity: 0.2 }); return 'done'; }
      }
      return 'abort';
    },
  },

  sleep: {
    category: 'body',
    propose(a, ctx) {
      const need = (1 - a.body.rest) + (ctx.world.isNight ? 0.55 : 0) + (1 - a.body.energy) * 0.5;
      if (need < 0.55) return [];
      const target = a.home ? T(a.home.x, a.home.y) : T(a.x, a.y);
      return [{ kind: 'sleep', u: need * 1.7, target, dur: 5 + Math.round(ctx.rng.float(0, 3)) }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      a.body.rest = clamp(a.body.rest + 0.2, 0, 1);
      a.body.energy = clamp(a.body.energy + 0.14, 0, 1);
      const sheltered = a.home && dist(a, a.home) < 1.5;
      if (sheltered) a.body.warmth = clamp(a.body.warmth + 0.1, 0, 1);
      if (--act.dur <= 0) { a.memory.consolidate(a); return 'done'; }
      return 'continue';
    },
  },

  seekWarmth: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.warmth > 0.42) return [];
      const hearth = topN(ctx.world.structuresOfKind('hearth'), 1, (s) => -dist(a, s))[0];
      const target = hearth || a.home;
      if (!target) return [];
      return [{ kind: 'seekWarmth', u: (0.6 - a.body.warmth) * 3.2, target: T(target.x, target.y), dur: 3 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      a.body.warmth = clamp(a.body.warmth + 0.16, 0, 1);
      if (--act.dur <= 0) return 'done';
      return 'continue';
    },
  },

  // ── work ──────────────────────────────────────────────────────────────────
  gather: {
    category: 'work',
    propose(a, ctx) {
      const laden = a.carried() > a.carryLimit;
      const out = [];
      const known = new Set(a.memory.knownKeys('matter').concat([...a.memory.semantic.keys()]));
      const scored = [];
      for (const c of ctx.ont.matter()) {
        if (!(known.has(c.key) || a.genome.curiosity > 0.5)) continue;
        if (laden && !(c.functions.sustenance && a.body.hunger > 0.35)) continue;
        scored.push({ c, desire: a.desireFor(c.key, ctx.ont, ctx.sim) });
      }
      for (const { c, desire } of topN(scored, 5, (s) => s.desire)) {
        const remembered = a.memory.belief(`where:${c.key}`)?.payload;
        const spot = ctx.world.findResource(c.key, a, 18 + a.genome.acuity * 16)
          || (remembered && ctx.world.bedAt(remembered.x, remembered.y)?.[c.key]?.amount > 1 ? remembered : null);
        if (!spot) continue;
        const travel = dist(a, spot);
        const feedsMe = c.functions.sustenance ? 1 + a.body.hunger * 2.2 : 1;
        const u = desire * 1.9 * feedsMe * ctx.bias.work / (1 + travel * 0.06) * (0.6 + a.skills.forage);
        out.push({ kind: 'gather', u, payload: c.key, target: beside(ctx.world, spot), site: spot, dur: 2 });
      }
      return topN(out, 3, (o) => o.u);
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      const yieldAmt = 3 + Math.floor((1.1 + a.skills.forage * 3) * ctx.rng.float(0.7, 1.5));
      const got = ctx.world.harvest(act.site.x, act.site.y, act.payload, yieldAmt);
      if (got <= 0) {
        a.memory.learn(`where:${act.payload}`, { kind: 'place', confidence: 0.2, valence: -0.3, payload: null });
        return 'abort';
      }
      a.add(act.payload, got);
      a.stats.harvested += got;
      a.gainSkill('forage', 0.02);
      a.memory.learn(`where:${act.payload}`, { kind: 'place', confidence: 0.6, valence: 0.4, payload: { x: act.site.x, y: act.site.y } });
      a.memory.learn(act.payload, { kind: 'matter', confidence: 0.5, valence: 0.3 });
      a.memory.link(act.payload, 'found-at', `${act.site.x},${act.site.y}`, 0.4);
      ctx.sim.record(a, 'gather', `${a.name} gathered ${Math.round(got)} ${ctx.ont.get(act.payload).word}`, { valence: 0.25, intensity: 0.2, concept: act.payload, quiet: true });
      appraise(a, { goalCongruence: 0.3, agency: 'self', intensity: 0.25, kind: 'gather' });
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
      const capability = 0.25 + a.skills.hunt * 0.9 + (weapon ? weapon.score * 0.9 : 0);
      const risk = clamp(0.5 - capability * 0.4);
      const u = hungerPull * capability * ctx.bias.work * (1 - risk * (1 - a.genome.risk)) / (1 + dist(a, spot) * 0.05);
      return [{ kind: 'hunt', u, target: beside(ctx.world, spot), site: spot, dur: 3, weapon: weapon?.key || null }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      const weapon = act.weapon ? ctx.ont.get(act.weapon) : null;
      const power = 0.2 + a.skills.hunt * 0.8 + (weapon ? weapon.serves('weapon') : 0) + a.body.energy * 0.3;
      a.body.energy = clamp(a.body.energy - 0.18, 0, 1);
      if (ctx.rng.next() < clamp(power / (power + 0.75))) {
        const got = ctx.world.harvest(act.site.x, act.site.y, 'game', 1 + Math.floor(power));
        if (got <= 0) return 'abort';
        a.add('meat', got * 2); a.add('hide', got); a.add('bone', got);
        a.stats.harvested += got * 4;
        a.gainSkill('hunt', 0.05);
        ctx.sim.record(a, 'hunt', `${a.name} brought down game on the ${ctx.world.season} ground`, { valence: 0.6, intensity: 0.6, concept: 'meat' });
        appraise(a, { goalCongruence: 0.7, agency: 'self', intensity: 0.6, kind: 'hunt' });
        for (const k of ['meat', 'hide', 'bone']) a.memory.learn(k, { kind: 'matter', confidence: 0.6, valence: 0.4 });
      } else {
        const hurt = ctx.rng.float(0.05, 0.3) / a.genome.resilience;
        a.body.injury = clamp(a.body.injury + hurt);
        ctx.world.danger[ctx.world.idx(act.site.x, act.site.y)] = clamp(ctx.world.danger[ctx.world.idx(act.site.x, act.site.y)] + 0.3);
        ctx.sim.record(a, 'injury', `${a.name} was hurt hunting and came back with nothing`, { valence: -0.7, intensity: 0.7 });
        appraise(a, { goalCongruence: -0.6, agency: 'world', intensity: 0.7, kind: 'injury', certainty: 0.4 });
      }
      return 'done';
    },
  },

  craft: {
    category: 'work',
    propose(a, ctx) {
      const out = [];
      if (a.carried() > a.carryLimit * 0.95) return [];
      const hungryHousehold = a.body.hunger > 0.35 || ctx.sim.totalFood() < ctx.sim.living.length * 2;
      let looked = 0;
      for (const key of a.memory.knownKeys('recipe')) {
        if (++looked > 24) break;
        const c = ctx.ont.get(key);
        if (!c) continue;
        const have = c.parents.every((p) => a.count(p) >= 1);
        if (!have) continue;
        // Nobody grinds their last meal into a trinket while the pot is empty.
        if (hungryHousehold && !c.functions.sustenance &&
            c.parents.some((p) => (ctx.ont.get(p)?.serves('sustenance') || 0) > 0.2)) continue;
        const desire = a.desireFor(key, ctx.ont, ctx.sim);
        out.push({ kind: 'craft', u: desire * 1.3 * ctx.bias.work * (0.5 + a.skills.craft), payload: key, dur: 2 + c.tier });
      }
      return topN(out, 2, (o) => o.u);
    },
    run(a, ctx, act) {
      if (--act.dur > 0) return 'continue';
      const c = ctx.ont.get(act.payload);
      for (const p of c.parents) if (!a.take(p, 1)) return 'abort';
      a.add(act.payload, 1);
      c.uses++;
      a.stats.crafted++;
      a.gainSkill('craft', 0.035);
      a.body.energy = clamp(a.body.energy - 0.07, 0, 1);
      ctx.sim.record(a, 'craft', `${a.name} made ${c.word}`, { valence: 0.4, intensity: 0.35, concept: c.key, quiet: true });
      appraise(a, { goalCongruence: 0.45, agency: 'self', intensity: 0.4, kind: 'craft' });
      return 'done';
    },
  },

  experiment: {
    category: 'thought',
    propose(a, ctx) {
      if (a.body.hunger > 0.72 || a.body.energy < 0.25) return [];
      const owned = [...a.inventory.keys()].filter((k) => ctx.ont.get(k));
      if (owned.length < 1) return [];
      const u = (0.55 + a.genome.curiosity * 1.9) * ctx.bias.explore * (0.7 + a.skills.craft) *
        (1 - a.body.hunger * 0.5) * (a.affect.e.awe * 0.5 + 0.95) * (1 + ctx.sim.capabilityGaps(a).length * 0.12);
      return [{ kind: 'experiment', u, dur: 2 + Math.round((1 - a.genome.patience) * 2) }];
    },
    run(a, ctx, act) {
      if (--act.dur > 0) return 'continue';
      const owned = [...a.inventory.keys()].filter((k) => ctx.ont.get(k));
      if (!owned.length) return 'abort';
      const procs = ctx.ont.availableProcesses();
      // Curiosity guided by what they feel is missing, not by a recipe list.
      const gaps = ctx.sim.capabilityGaps(a);   // what this person feels they lack
      // Materials are chosen by hunch: things they value, or things whose
      // properties gesture at the gap they are trying to close.
      const short = a.body.hunger > 0.35 || ctx.sim.totalFood() < ctx.sim.living.length * 2;
      const weight = (k) => {
        const c = ctx.ont.get(k);
        let w = 0.3 + (a.memory.belief(k)?.confidence || 0) * 0.6;
        if (short && c.serves('sustenance') > 0.2) w *= 0.08;
        for (const g of gaps) w += (c.functions[g] || 0) * 1.5 + (c.props.hard + c.props.flexible) * 0.1;
        return w;
      };
      const aKey = ctx.rng.weighted(owned.map((k) => [k, weight(k)]));
      const bKey = ctx.rng.bool(0.78) ? ctx.rng.weighted(owned.map((k) => [k, weight(k)])) : null;
      const proc = ctx.rng.weighted(procs.map((p) => [p, 1 + (a.memory.belief(`proc:${p}`)?.confidence || 0) * 1.5]));
      a.memory.learn(`proc:${proc}`, { kind: 'process', confidence: 0.08, valence: 0 });
      const res = ctx.ont.attempt(a, aKey, bKey && bKey !== aKey ? bKey : null, proc);
      a.stats.ideas++;
      a.body.energy = clamp(a.body.energy - 0.06, 0, 1);
      a.gainSkill('craft', 0.02);
      if (!res.ok) {
        if (res.reason === 'known' && res.concept) {
          a.memory.learn(res.concept.key, { kind: 'recipe', confidence: 0.5, valence: 0.2, source: 'rediscovery' });
        } else {
          appraise(a, { goalCongruence: -0.15, agency: 'self', intensity: 0.2, kind: 'failure' });
        }
        return 'done';
      }
      const c = res.concept;
      for (const p of c.parents) a.take(p, 1);
      a.add(c.key, 1);
      a.memory.learn(c.key, { kind: 'recipe', confidence: 0.85, valence: 0.7, source: 'invention' });
      for (const p of c.parents) a.memory.link(p, 'combines-into', c.key, 0.6);
      a.memory.link(c.key, 'serves', c.bestFn, 0.7);
      a.stats.inventions++;
      a.gainSkill('craft', 0.05);
      const proud = res.advance ? 0.95 : 0.35;
      appraise(a, { goalCongruence: proud, agency: 'self', intensity: proud, novelty: 1, kind: 'invention' });
      ctx.sim.onInvention(a, res.record, c);
      return 'done';
    },
  },

  build: {
    category: 'work',
    propose(a, ctx) {
      if (a.isChild(ctx.tick)) return [];
      // Local needs: each settlement builds for its own cluster
      const nearest = ctx.sim.nearestSettlement(a);
      const s = ctx.sim.settlementNeeds(nearest);
      const out = [];
      for (const [kind, def] of Object.entries(STRUCTURE_KINDS)) {
        const need = def.need(s);
        if (need <= 0.05) continue;
        const material = ctx.sim.bestBuildMaterial(a, def.fn);
        if (!material) continue;
        const cost = Math.ceil(def.cost / (0.5 + material.score));
        if (a.count(material.key) < cost) {
          // Wanting a thing built is itself a reason to go fetch stone or timber.
          const spot = ctx.world.findResource(material.key, a, 16);
          if (spot && a.carried() <= a.carryLimit) {
            out.push({ kind: 'gather', u: need * 1.25 * ctx.bias.work * (0.5 + a.genome.industry),
              payload: material.key, target: beside(ctx.world, spot), site: spot, dur: 2 });
          }
          continue;
        }
        const u = need * 1.5 * ctx.bias.work * (0.4 + a.skills.build) * (0.5 + a.genome.industry);
        out.push({ kind: 'build', u, payload: { structure: kind, material: material.key, cost, fn: def.fn }, dur: 4 + Math.round(def.cost / 3) });
      }
      return topN(out, 2, (o) => o.u);
    },
    run(a, ctx, act) {
      if (!act.spot) act.spot = ctx.sim.pickBuildSite(a, act.payload.structure);
      if (!act.spot) return 'abort';
      if (dist(a, act.spot) > 1.2) { stepToward(a, ctx.world, act.spot); return 'continue'; }
      a.body.energy = clamp(a.body.energy - 0.05, 0, 1);
      if (--act.dur > 0) return 'continue';
      if (a.take(act.payload.material, act.payload.cost) < act.payload.cost) return 'abort';
      const st = ctx.sim.raiseStructure(a, act.payload.structure, act.spot, act.payload.material);
      a.stats.built++;
      a.gainSkill('build', 0.07);
      appraise(a, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'first' });
      if (!a.home && (act.payload.structure === 'shelter')) a.home = st;
      return 'done';
    },
  },

  // ── expansion ─────────────────────────────────────────────────────────────
  foundSettlement: {
    category: 'work',
    propose(a, ctx) {
      try {
        if (a.isChild(ctx.tick)) return [];
        if (!ctx.sim.settlements || !ctx.sim.settlements.length) return [];

        const nearest = ctx.sim.nearestSettlement(a);
        if (!nearest) return [];

        const localPop = ctx.sim.living.filter(x => {
          const ns = ctx.sim.nearestSettlement(x);
          return ns && ns.id === nearest.id;
        }).length;

        const crowding = localPop / 40;
        if (crowding < 0.40) return [];

        const candidates = [];
        for (const key of a.memory.knownKeys('place')) {
          const b = a.memory.belief(key);
          if (!b || !b.payload || b.payload.x == null || b.payload.y == null) continue;
          const pos = b.payload;
          const farEnough = ctx.sim.settlements.every(s =>
            (s.x - pos.x) ** 2 + (s.y - pos.y) ** 2 > 28 * 28
          );
          if (farEnough) {
            candidates.push({ pos, conf: b.confidence || 0.3 });
          }
        }

        // Fallback scout spot when the cluster is already dense
        if (!candidates.length && crowding > 0.55 && a.genome.curiosity > 0.4) {
          const angle = ctx.rng.float(0, Math.PI * 2);
          const d = 26 + ctx.rng.int(0, 16);
          const px = clamp(Math.round(nearest.x + Math.cos(angle) * d), 2, ctx.world.w - 3);
          const py = clamp(Math.round(nearest.y + Math.sin(angle) * d), 2, ctx.world.h - 3);
          if (ctx.world.walkable(px, py)) {
            candidates.push({ pos: { x: px, y: py }, conf: 0.22 });
          }
        }

        if (!candidates.length) return [];

        candidates.sort((x, y) => y.conf - x.conf);
        const best = candidates[0];

        const u = (0.70 + crowding * 0.85 + best.conf * 0.35) *
                  (0.65 + a.genome.curiosity * 0.7 + a.genome.industry * 0.45) *
                  (1 - a.body.hunger * 0.30) *
                  (1 - a.body.thirst * 0.20);

        return [{
          kind: 'foundSettlement',
          u: Math.max(0.01, u),
          target: { x: best.pos.x, y: best.pos.y },
          site: best.pos,
          dur: 12,
        }];
      } catch (e) {
        console.warn('foundSettlement.propose error', e);
        return [];
      }
    },
    run(a, ctx, act) {
      try {
        if (!act.target) return 'abort';
        if (dist(a, act.target) > 2.8) {
          stepToward(a, ctx.world, act.target);
          a.body.energy = clamp(a.body.energy - 0.012, 0, 1);
          return 'continue';
        }
        const ok = ctx.sim.foundSettlement(a, act.site || act.target);
        if (ok) {
          appraise(a, {
            goalCongruence: 0.92,
            agency: 'self',
            intensity: 0.9,
            kind: 'first',
            novelty: 0.85,
          });
          return 'done';
        }
        return 'abort';
      } catch (e) {
        console.warn('foundSettlement.run error', e);
        return 'abort';
      }
    },
  },
  {
    category: 'work',
    propose(a, ctx) {
      const fields = ctx.world.structuresOfKind('field');
      if (!fields.length) return [];
      const f = topN(fields, 1, (s) => (s.ripeness || 0) * 2 - dist(a, s) * 0.05)[0];
      if (!f) return [];
      const ripe = f.ripeness || 0;
      const u = (ripe > 0.85 ? 1.9 + a.body.hunger : 0.5) * ctx.bias.work * (0.4 + a.skills.farm) / (1 + dist(a, f) * 0.05);
      return [{ kind: 'farm', u, target: T(f.x, f.y), field: f, dur: 2 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      const f = act.field;
      if ((f.ripeness || 0) > 0.85) {
        const got = 2 + Math.round(a.skills.farm * 5 + ctx.world.fertility[ctx.world.idx(f.x, f.y)] * 4);
        a.add('grain', got);
        f.ripeness = 0;
        f.harvests = (f.harvests || 0) + 1;
        a.stats.harvested += got;
        a.gainSkill('farm', 0.05);
        ctx.sim.record(a, 'harvest', `${a.name} took ${Math.round(got)} ${ctx.ont.get('grain').word} from the ${f.word}`, { valence: 0.6, intensity: 0.5, concept: 'grain' });
        appraise(a, { goalCongruence: 0.65, agency: 'self', intensity: 0.5, kind: 'harvest' });
      } else {
        f.tended = (f.tended || 0) + 0.15 + a.skills.farm * 0.2;
        a.gainSkill('farm', 0.02);
        if (--act.dur > 0) return 'continue';
      }
      return 'done';
    },
  },

  store: {
    category: 'work',
    propose(a, ctx) {
      const stores = ctx.world.structuresOfKind('store');
      if (!stores.length) return [];
      let surplus = 0;
      for (const [k, v] of a.inventory) {
        const c = ctx.ont.get(k);
        if (c?.functions.sustenance && v > 3) surplus += v - 3;
      }
      if (surplus < 2) return [];
      const s = topN(stores, 1, (x) => -dist(a, x))[0];
      const u = surplus * 0.16 * (0.5 + a.genome.patience) * ctx.bias.hoard;
      return [{ kind: 'store', u, target: T(s.x, s.y), store: s, dur: 1 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      let moved = 0;
      for (const [k, v] of [...a.inventory]) {
        const c = ctx.ont.get(k);
        if (c?.functions.sustenance && v > 3) {
          const give = v - 3;
          a.take(k, give);
          act.store.stock.set(k, (act.store.stock.get(k) || 0) + give);
          moved += give;
        }
      }
      if (moved) ctx.sim.record(a, 'store', `${a.name} laid ${Math.round(moved)} measures of food into the ${act.store.word}`, { valence: 0.35, intensity: 0.3, quiet: true });
      return 'done';
    },
  },

  // ── social ────────────────────────────────────────────────────────────────
  converse: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 6).filter((o) => o.id !== a.id);
      if (!near.length) return [];
      const out = [];
      for (const o of near.slice(0, 4)) {
        const r = a.rel(o);
        const lonely = 1 - clamp(r.familiarity);
        const u = (0.2 + a.genome.sociability * 0.8) * ctx.bias.social * (1 - a.body.hunger * 0.6) *
          (0.4 + lonely * 0.6 + r.affection * 0.5 + a.genome.expressive * 0.3) / (1 + dist(a, o) * 0.12);
        out.push({ kind: 'converse', u, targetId: o.id, dur: 2 });
      }
      return topN(out, 2, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      ctx.sim.converse(a, o);
      if (--act.dur > 0) return 'continue';
      return 'done';
    },
  },

  teach: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 5).filter((o) => o.id !== a.id);
      if (!near.length) return [];
      const mine = a.memory.knownKeys('recipe');
      if (!mine.length) return [];
      const out = [];
      for (const o of near) {
        const unknown = mine.filter((k) => !o.memory.knows(k, 0.3));
        if (!unknown.length) continue;
        const kinBonus = a.children.includes(o.id) ? 1.4 : 0;
        const u = (0.25 + a.genome.empathy * 0.9 + kinBonus) * ctx.bias.social * (0.4 + a.skills.teach) *
          (a.isElder(ctx.tick) ? 1.5 : 1) * (o.isChild(ctx.tick) ? 1.4 : 1);
        out.push({ kind: 'teach', u, targetId: o.id, payload: ctx.rng.pick(unknown), dur: 3 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      ctx.sim.teach(a, o, act.payload);
      return 'done';
    },
  },

  trade: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 7).filter((o) => o.id !== a.id && !o.isChild(ctx.tick));
      const out = [];
      for (const o of near) {
        const r = a.rel(o);
        if (ctx.world.tick - (r.lastTrade || -999) < 30) continue;
        const deal = ctx.sim.findDeal(a, o);
        if (!deal) continue;
        out.push({ kind: 'trade', u: deal.gain * 0.6 * (0.5 + r.trust) * (0.5 + a.skills.trade + a.genome.sociability * 0.5), targetId: o.id, deal, dur: 2 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      ctx.sim.settleTrade(a, o, act.deal);
      return 'done';
    },
  },

  give: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 5).filter((o) => o.id !== a.id);
      const out = [];
      for (const o of near) {
        const r = a.rel(o);
        const r0 = a.rel(o);
        const kinChild = o.isChild(ctx.tick) && (r0.kin > 0.3 || a.household === o.household);
        const theirNeed = o.body.hunger * 1.4 + o.body.illness + (kinChild ? 0.5 : 0);
        if (theirNeed < (kinChild ? 0.35 : 0.6) || a.body.hunger > (kinChild ? 0.72 : 0.5)) continue;
        let gift = null;
        for (const [k, v] of a.inventory) {
          const c = ctx.ont.get(k);
          if (!c) continue;
          if (o.body.hunger > 0.6 && c.functions.sustenance && v > 1) { gift = k; break; }
          if (o.body.illness > 0.3 && c.functions.medicine && v > 0) { gift = k; break; }
        }
        if (!gift) continue;
        const u = theirNeed * (a.genome.empathy * 1.5 + r.affection * 1.2 + r.kin * 1.5 + (r.debt < 0 ? 0.6 : 0)) * ctx.bias.social;
        out.push({ kind: 'give', u, targetId: o.id, payload: gift, dur: 1 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      if (!a.take(act.payload, 1)) return 'abort';
      o.add(act.payload, 1);
      a.stats.gifts++; ctx.sim.counters.gifts++;
      const word = ctx.ont.get(act.payload)?.word || act.payload;
      a.adjustRel(o, { affection: 0.08, familiarity: 0.06, debt: -0.4 });
      o.adjustRel(a, { affection: 0.16, trust: 0.14, familiarity: 0.08, debt: 0.5 });
      ctx.sim.record(a, 'gift', `${a.name} gave ${word} to ${o.name}, who had none`, { valence: 0.6, intensity: 0.6, actors: [a.id, o.id] });
      appraise(a, { goalCongruence: 0.4, agency: 'self', intensity: 0.5, kind: 'gift', norm: 1, social: o.id });
      appraise(o, { goalCongruence: 0.7, agency: 'other', intensity: 0.7, kind: 'gift', social: a.id });
      ctx.sim.reputationDelta(a, 0.05);
      return 'done';
    },
  },

  steal: {
    category: 'social',
    propose(a, ctx) {
      const desperate = a.body.hunger > 0.75 || a.body.illness > 0.5;
      if (!desperate && a.genome.empathy > 0.35) return [];
      const near = ctx.nearby(a, 5).filter((o) => o.id !== a.id && o.carried() > 2);
      const out = [];
      for (const o of near) {
        const norm = ctx.sim.normStrength('theft');
        const u = (a.body.hunger * 1.5 + (1 - a.genome.empathy)) * (1 - norm * 1.3) * (0.4 + a.genome.risk) - a.rel(o).affection;
        if (u <= 0.2) continue;
        out.push({ kind: 'steal', u, targetId: o.id, dur: 1 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      const keys = [...o.inventory.keys()];
      if (!keys.length) return 'abort';
      const key = topN(keys, 1, (k) => a.desireFor(k, ctx.ont, ctx.sim))[0];
      const n = o.take(key, 1 + Math.floor(a.genome.risk * 2));
      if (!n) return 'abort';
      a.add(key, n);
      a.stats.thefts++;
      ctx.sim.onTheft(a, o, key, n);
      return 'done';
    },
  },

  court: {
    category: 'social',
    propose(a, ctx) {
      const age = a.ageAt(ctx.tick);
      if (age < 15 || age > 52 || a.partner) return [];
      const near = ctx.nearby(a, 8).filter((o) => o.id !== a.id && !o.partner && o.ageAt(ctx.tick) > 16 && o.ageAt(ctx.tick) < 50 && a.rel(o).kin < 0.4);
      const out = [];
      for (const o of near) {
        const r = a.rel(o);
        const u = (r.affection * 1.6 + r.familiarity * 1.1 + a.genome.fertility * 0.7 + a.affect.e.love + 0.25) * ctx.bias.social;
        if (u < 0.3) continue;
        out.push({ kind: 'court', u, targetId: o.id, dur: 3 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive || o.partner) return 'abort';
      if (dist(a, o) > 1.4) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      a.adjustRel(o, { affection: 0.12, familiarity: 0.1 });
      o.adjustRel(a, { affection: 0.1, familiarity: 0.1 });
      if (--act.dur > 0) return 'continue';
      ctx.sim.tryBond(a, o);
      return 'done';
    },
  },

  fight: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 4).filter((o) => o.id !== a.id);
      const out = [];
      if (a.affect.e.anger < 0.45) return [];
      if (ctx.world.tick - (a.lastFightTick || -999) < 60) return [];
      for (const o of near) {
        const r = a.rel(o);
        if (r.kin > 0.5 || r.affection > 0.15) continue;
        const grudge = clamp(-r.affection) + Math.min(0.35, r.conflicts * 0.07);
        const u = (a.affect.e.anger * 1.1 + grudge * 0.9) * (0.15 + a.genome.aggression * 1.2) * ctx.bias.aggress
          * (1 - a.genome.empathy * 0.7) - ctx.sim.normStrength('violence') * 1.6;
        if (u < 0.95) continue;
        out.push({ kind: 'fight', u, targetId: o.id, dur: 1 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      ctx.sim.resolveFight(a, o);
      return 'done';
    },
  },

  // Small children stay near whoever raises them; partners drift back to each other.
  follow: {
    category: 'social',
    propose(a, ctx) {
      const age = a.ageAt(ctx.tick);
      let leader = null, weight = 0;
      if (age < 11) {
        for (const id of [a.motherId, a.fatherId]) {
          const p = id && ctx.sim.byId(id);
          if (p && p.alive) { leader = p; weight = 2.4 - age * 0.12; break; }
        }
        if (!leader) {
          const adults = ctx.nearby(a, 20).filter((o) => o.id !== a.id && !o.isChild(ctx.tick));
          if (adults.length) { leader = adults.sort((x, y) => dist(a, x) - dist(a, y))[0]; weight = 1.6; }
        }
      } else if (a.partner) {
        const p = ctx.sim.byId(a.partner);
        if (p && p.alive) { leader = p; weight = 0.5 + a.rel(p).affection * 0.8; }
      }
      if (!leader) return [];
      const d = dist(a, leader);
      if (d < 3) return [];
      return [{ kind: 'follow', u: weight * Math.min(1.6, d * 0.16), targetId: leader.id, dur: 1 }];
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) <= 2.2) return 'done';
      stepToward(a, ctx.world, T(o.x, o.y));
      return 'continue';
    },
  },

  care: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 6).filter((o) => o.id !== a.id && (o.body.illness > 0.3 || o.body.injury > 0.3));
      const out = [];
      const remedy = a.bestToolFor('medicine', ctx.ont);
      for (const o of near) {
        const r = a.rel(o);
        const u = (o.body.illness + o.body.injury) * (a.genome.empathy * 1.4 + r.kin * 1.2 + r.affection) * (0.4 + a.skills.heal + (remedy ? remedy.score : 0));
        out.push({ kind: 'care', u, targetId: o.id, payload: remedy?.key || null, dur: 2 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) { stepToward(a, ctx.world, T(o.x, o.y)); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      const remedyPower = act.payload ? ctx.ont.get(act.payload).serves('medicine') : 0;
      const heal = 0.12 + a.skills.heal * 0.4 + remedyPower * 0.6;
      const before = o.body.illness + o.body.injury;
      o.body.illness = clamp(o.body.illness - heal, 0, 1);
      o.body.injury = clamp(o.body.injury - heal, 0, 1);
      if (act.payload) a.take(act.payload, 1);
      a.gainSkill('heal', 0.06);
      a.stats.rescues++;
      o.adjustRel(a, { trust: 0.2, affection: 0.18, debt: 0.6 });
      a.adjustRel(o, { affection: 0.1, familiarity: 0.08 });
      ctx.sim.record(a, 'rescue', `${a.name} tended ${o.name}${act.payload ? ` with ${ctx.ont.get(act.payload).word}` : ''}`, { valence: 0.6, intensity: 0.6, actors: [a.id, o.id] });
      appraise(o, { goalCongruence: clamp(before, 0, 1), agency: 'other', intensity: 0.6, kind: 'rescue', social: a.id });
      if (remedyPower > 0.2) a.memory.learn(act.payload, { kind: 'recipe', confidence: 0.3, valence: 0.6, source: 'healing' });
      return 'done';
    },
  },

  bury: {
    category: 'ritual',
    propose(a, ctx) {
      if (!ctx.world.corpses.length) return [];
      const c = topN(ctx.world.corpses, 1, (k) => -dist(a, k))[0];
      if (!c || dist(a, c) > 22) return [];
      const r = a.rel(c.id);
      const u = (0.5 + a.genome.empathy + r.kin * 1.5 + r.affection + a.affect.e.grief) * 1.2;
      return [{ kind: 'bury', u, target: T(c.x, c.y), corpse: c, dur: 3 }];
    },
    run(a, ctx, act) {
      if (!ctx.world.corpses.includes(act.corpse)) return 'abort';
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      ctx.sim.bury(a, act.corpse);
      return 'done';
    },
  },

  ritual: {
    category: 'ritual',
    propose(a, ctx) {
      const shrines = ctx.world.structuresOfKind('shrine').concat(ctx.world.sites.filter((s) => s.kind === 'graves'));
      if (!shrines.length) return [];
      const s = topN(shrines, 1, (x) => -dist(a, x))[0];
      const u = (a.affect.e.grief * 1.4 + a.affect.e.awe * 1.2 + a.genome.expressive * 0.5 + ctx.sim.ritualPull) * 0.9 / (1 + dist(a, s) * 0.04);
      if (u < 0.4) return [];
      return [{ kind: 'ritual', u, target: T(s.x, s.y), site: s, dur: 3 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) { stepToward(a, ctx.world, act.target); return 'continue'; }
      if (--act.dur > 0) return 'continue';
      ctx.sim.performRitual(a, act.site);
      return 'done';
    },
  },

  makeArt: {
    category: 'thought',
    propose(a, ctx) {
      const medium = a.bestToolFor('art', ctx.ont) || a.bestToolFor('record', ctx.ont);
      const u = (a.genome.expressive * 1.3 + a.affect.e.awe + a.affect.e.grief * 0.8 + a.affect.e.love * 0.6) * ctx.bias.create * (medium ? 1.4 : 0.6) - a.body.hunger;
      if (u < 0.6) return [];
      return [{ kind: 'makeArt', u, payload: medium?.key || null, dur: 3 }];
    },
    run(a, ctx, act) {
      if (--act.dur > 0) return 'continue';
      ctx.sim.makeArt(a, act.payload);
      a.gainSkill('art', 0.06);
      return 'done';
    },
  },

  explore: {
    category: 'thought',
    propose(a, ctx) {
      const u = (0.25 + a.genome.curiosity * 1.1) * ctx.bias.explore * (1 - a.body.hunger * 0.8) * (a.body.energy);
      const r = 8 + Math.round(a.genome.curiosity * 26);
      let target = null;
      for (let i = 0; i < 12 && !target; i++) {
        const t = T(clamp(a.x + ctx.rng.int(-r, r), 1, ctx.world.w - 2), clamp(a.y + ctx.rng.int(-r, r), 1, ctx.world.h - 2));
        if (ctx.world.walkable(t.x, t.y)) target = t;
      }
      if (!target) return [];
      return [{ kind: 'explore', u, target, dur: 12 }];
    },
    run(a, ctx, act) {
      const arrived = stepToward(a, ctx.world, act.target);
      const bed = ctx.world.bedAt(a.x, a.y);
      if (bed) {
        for (const key of Object.keys(bed)) {
          if (key === 'game') continue;
          const known = a.memory.knows(key, 0.3);
          a.memory.learn(key, { kind: 'matter', confidence: known ? 0.15 : 0.6, valence: 0.3, source: 'exploration' });
          a.memory.learn(`where:${key}`, { kind: 'place', confidence: 0.5, valence: 0.3, payload: { x: a.x, y: a.y } });
          if (!known) {
            ctx.sim.record(a, 'discovery', `${a.name} found ${ctx.ont.get(key)?.word || key} out past the ${ctx.world.season} ground`, { valence: 0.5, intensity: 0.5, concept: key, quiet: true });
            appraise(a, { goalCongruence: 0.35, agency: 'self', intensity: 0.4, novelty: 0.8, kind: 'discovery' });
          }
        }
      }
      a.body.energy = clamp(a.body.energy - 0.012, 0, 1);
      if (arrived || --act.dur <= 0) return 'done';
      return 'continue';
    },
  },

  idle: {
    category: 'body',
    propose(a) { return [{ kind: 'idle', u: 0.08, dur: 1 }]; },
    run(a, ctx) {
      a.body.rest = clamp(a.body.rest + 0.02, 0, 1);
      if (ctx.rng.bool(0.25)) {
        const t = T(clamp(a.x + ctx.rng.int(-1, 1), 1, ctx.world.w - 2), clamp(a.y + ctx.rng.int(-1, 1), 1, ctx.world.h - 2));
        stepToward(a, ctx.world, t);
      }
      return 'done';
    },
  },
};

export { STRUCTURE_KINDS, stepToward, beside, nearWater };
