// Everything an inhabitant can choose to do.
// Bridges cost and place a full bank→bank span (world.findBridgeSpan).

import { clamp, dist, topN } from '../core/util.js';
import { TERRAIN } from '../world/world.js';
import { appraise } from './emotion.js';

const T = (x, y) => ({ x, y });

function stepToward(agent, world, target) {
  const ax = agent.x | 0;
  const ay = agent.y | 0;
  const tx = target.x | 0;
  const ty = target.y | 0;
  if (ax === tx && ay === ty) return true;

  const maxNodes = 120;
  const key = (x, y) => `${x},${y}`;
  const came = new Map();
  const q = [[ax, ay]];
  came.set(key(ax, ay), null);
  let found = null;
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];

  while (q.length && came.size < maxNodes) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) {
      found = [x, y];
      break;
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (came.has(k)) continue;
      if (!world.walkable(nx, ny)) continue;
      came.set(k, [x, y]);
      q.push([nx, ny]);
    }
  }

  let next = null;
  if (found) {
    let cur = found;
    while (came.get(key(cur[0], cur[1]))) {
      const prev = came.get(key(cur[0], cur[1]));
      if (prev[0] === ax && prev[1] === ay) {
        next = cur;
        break;
      }
      cur = prev;
    }
  }

  if (!next) {
    let best = null;
    let bestD = Infinity;
    for (const [dx, dy] of dirs) {
      const nx = ax + dx;
      const ny = ay + dy;
      if (!world.walkable(nx, ny)) continue;
      const d = Math.abs(nx - tx) + Math.abs(ny - ty);
      if (d < bestD) {
        bestD = d;
        best = [nx, ny];
      }
    }
    if (best) next = best;
  }

  if (!next) {
    for (const [dx, dy] of dirs) {
      const nx = ax + dx;
      const ny = ay + dy;
      if (!world.walkable(nx, ny)) continue;
      next = [nx, ny];
      break;
    }
  }

  if (!next) return false;

  agent.x = next[0];
  agent.y = next[1];
  agent.stats.steps = (agent.stats.steps || 0) + 1;
  const idx = world.idx(agent.x, agent.y);
  if (world.trails) {
    world.trails[idx] = clamp((world.trails[idx] || 0) + 0.02, 0, 1);
  }

  const st = world.structureAt?.(agent.x, agent.y);
  if (st?.kind === 'bridge' && agent.memory) {
    learnStructureUse(agent, 'bridge', 'crossing', 0.22, 0.5);
    agent.memory.learn('lesson:crossing', {
      kind: 'lesson',
      confidence: 0.35,
      valence: 0.5,
      source: 'experience',
      payload: { do: 'bridge' },
    });
  }

  return agent.x === tx && agent.y === ty;
}

function learnStructureUse(a, kind, serves, conf = 0.2, valence = 0.4) {
  if (!a?.memory?.learn) return;
  const key = `structure:${kind}`;
  const existing = a.memory.belief?.(key);
  const nextConf = existing
    ? Math.min(0.85, (existing.confidence || 0) + conf * 0.5)
    : conf;
  a.memory.learn(key, {
    kind: 'lesson',
    confidence: nextConf,
    valence: Math.max(existing?.valence || 0, valence),
    source: 'experience',
    payload: { serves, structure: kind },
  });
}

function knownStructureUse(a, kind) {
  const b = a.memory?.belief?.(`structure:${kind}`);
  if (!b || b.confidence < 0.12) return 0.22;
  return clamp(0.35 + b.confidence * (0.5 + Math.max(0, b.valence)), 0.2, 1.25);
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

function normsFor(a, ctx, tags = []) {
  if (!tags.length) return 0;
  let sum = 0;
  let n = 0;
  const consider = (key) => {
    let v = 0;
    if (typeof ctx.sim?.effectiveNorm === 'function') v = ctx.sim.effectiveNorm(a, key);
    else if (typeof ctx.sim?.personalNorm === 'function') v = ctx.sim.personalNorm(a, key);
    else {
      const b = a.memory.belief(`norm:${key}`);
      if (b && b.confidence >= 0.12) v = b.valence * b.confidence;
    }
    if (v !== 0) {
      sum += v;
      n++;
    }
  };
  for (const tag of tags) consider(tag);
  if (typeof a.memory.knownNorms === 'function') {
    for (const b of a.memory.knownNorms(0.12)) {
      const sit = b.payload?.situation || b.key.replace(/^norm:/, '');
      if (tags.includes(sit)) {
        sum += b.valence * b.confidence;
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

function normPull(a, ctx, key) {
  return normsFor(a, ctx, [key]);
}

function plazaBoost(ctx, a, mult = 1.25) {
  return structureBoost(ctx, a, ['plaza', 'market'], mult);
}

/** Multiplier when standing near institutions that make an activity pay. */
function structureBoost(ctx, a, kinds, mult = 1.25) {
  if (typeof ctx.world.hasStructureNear !== 'function') return 1;
  for (const k of kinds) {
    if (ctx.world.hasStructureNear(a.x, a.y, k, 7)) return mult;
  }
  return 1;
}

function availableMaterial(a, ctx, key, range = 12) {
  let n = a.count(key);
  for (const s of ctx.world.structuresOfKind('store')) {
    if (dist(a, s) > range || !s.stock) continue;
    n += s.stock.get(key) || 0;
  }
  return n;
}

function takeMaterial(a, ctx, key, amount = 1, range = 12) {
  let need = amount;
  const fromPerson = Math.min(need, a.count(key));
  if (fromPerson > 0) {
    a.take(key, fromPerson);
    need -= fromPerson;
  }
  if (need <= 0) return amount;
  const stores = ctx.world
    .structuresOfKind('store')
    .filter((s) => s.stock && dist(a, s) <= range)
    .sort((x, y) => dist(a, x) - dist(a, y));
  for (const s of stores) {
    const have = s.stock.get(key) || 0;
    const take = Math.min(need, have);
    if (take > 0) {
      s.stock.set(key, Math.max(0, have - take));
      need -= take;
    }
    if (need <= 0) return amount;
  }
  return amount - need;
}

const U = {
  thirstBase: 2.8,
  thirstCrisis: 8,
  hungerBase: 4,
  hungerCrisis: 22,
  sleepNeed: 1.7,
  warmth: 3.2,
  idle: 0.15,
};

const STRUCTURE_KINDS = {
  shelter:  { fn: 'shelter',    cost: 6,  need: (s) => s.shelterDeficit,  desc: 'a place to sleep out of the weather' },
  hearth:   { fn: 'heat',       cost: 4,  need: (s) => s.hearthDeficit,   desc: 'a fire that does not go out' },
  store:    { fn: 'storage',    cost: 7,  need: (s) => s.storeDeficit,    desc: 'somewhere to keep food for winter' },
  workshop: { fn: 'cutting',    cost: 9,  need: (s) => s.workshopDeficit, desc: 'a place to make things properly' },
  field:    { fn: 'sustenance', cost: 5,  need: (s) => s.fieldDeficit,    desc: 'ground turned for planted grain' },
  well:     { fn: 'vessel',     cost: 8,  need: (s) => s.wellDeficit,     desc: 'water that does not need a walk' },
  shrine:   { fn: 'art',        cost: 6,  need: (s) => s.shrineDeficit,   desc: 'a place for the dead and the questions' },
  market:   { fn: 'storage',    cost: 8,  need: (s) => s.marketDeficit,   desc: 'ground where goods change hands' },
  hall:     { fn: 'shelter',    cost: 14, need: (s) => s.hallDeficit,     desc: 'one roof for teaching and talk' },
  wall:     { fn: 'shelter',    cost: 14, need: (s) => s.wallDeficit,     desc: 'a boundary against what is out there' },
  bridge:   { fn: 'shelter',    cost: 10, need: (s) => s.bridgeDeficit,   desc: 'a way across water' },
  path:     { fn: 'shelter',    cost: 3,  need: (s) => s.pathDeficit,     desc: 'beaten ground that is easier to walk' },
  plaza:    { fn: 'art',        cost: 7,  need: (s) => s.plazaDeficit,    desc: 'open ground where people meet' },
};

/** Soft max copies near a camp; extra copies get no build pressure. */
function structureCap(kind, people) {
  const p = Math.max(1, people || 1);
  switch (kind) {
    case 'shelter': return Math.max(2, Math.ceil(p / 2.2));
    case 'hearth': return Math.max(1, Math.ceil(p / 10));
    case 'store': return Math.max(1, Math.ceil(p / 16));
    case 'field': return Math.max(1, Math.ceil(p / 7));
    case 'workshop': return p >= 8 ? Math.min(2, 1 + Math.floor(p / 22)) : 0;
    case 'market': return p >= 10 ? Math.min(2, 1 + Math.floor(p / 28)) : 0;
    case 'hall': return p >= 12 ? 1 : 0;
    case 'plaza': return p >= 10 ? 1 : 0;
    case 'shrine': return p >= 10 || p >= 8 ? 1 : 0;
    case 'well': return p >= 8 ? Math.min(2, 1 + Math.floor(p / 24)) : 0;
    case 'path': return Math.max(0, Math.ceil(p / 10));
    case 'wall': return p >= 40 ? 1 : 0;
    case 'bridge': return 2; // spans handled separately
    default: return 2;
  }
}

/** Institutions unlock from prerequisites + time — not all on day 0. */
function structureUnlocked(kind, ctx, settlement, nearCount) {
  const day = ctx.world.dayNumber || Math.floor((ctx.world.tick || 0) / 24) + 1;
  const n = (k) => nearCount(k);
  const hasStore = n('store') >= 1;
  const hasShelter = n('shelter') >= 1;
  const hasField = n('field') >= 1;
  const basics = hasStore && hasShelter;

  switch (kind) {
    case 'path':
    case 'shelter':
    case 'hearth':
      return true;
    case 'store':
      return true;
    case 'bridge':
      return day >= 3 || basics;
    case 'field':
      return day >= 5 || hasStore;
    case 'well':
      return day >= 12 && basics;
    case 'workshop':
      return day >= 25 && basics && hasField;
    case 'market':
      return day >= 35 && basics && (ctx.sim.counters?.exchanges || 0) >= 15;
    case 'plaza':
      return day >= 30 && basics;
    case 'hall':
      return day >= 40 && basics && n('workshop') + n('plaza') >= 1;
    case 'shrine':
      return day >= 20 && (basics || (ctx.world.corpses?.length || 0) >= 2);
    case 'wall':
      return day >= 60 && (nearCount('shelter') >= 4);
    default:
      return day >= 10;
  }
}

/** One major (non-path) build per settlement per day keeps a skyline from finishing on day 1. */
function settlementBuildAllowed(ctx, settlement, kind) {
  if (kind === 'path') return true;
  const key = settlement?.id || `${settlement?.x},${settlement?.y}` || 'camp';
  const tick = ctx.world.tick || 0;
  const map = ctx.sim._lastMajorBuildTick || (ctx.sim._lastMajorBuildTick = new Map());
  const last = map.get(key) ?? -999;
  // 18 hours between major structures at a camp
  return tick - last >= 18;
}

function noteSettlementBuild(ctx, settlement, kind) {
  if (kind === 'path') return;
  const key = settlement?.id || `${settlement?.x},${settlement?.y}` || 'camp';
  const map = ctx.sim._lastMajorBuildTick || (ctx.sim._lastMajorBuildTick = new Map());
  map.set(key, ctx.world.tick || 0);
}

export const ACTIONS = {
  drink: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.thirst < 0.18) return [];
      const own = a.count('water');
      const wells = ctx.world.structuresOfKind('well') || [];
      let well = null;
      let wd = Infinity;
      for (const w of wells) {
        const d = dist(a, w);
        if (d < wd) {
          wd = d;
          well = w;
        }
      }
      const spot =
        own > 0
          ? null
          : nearWater(ctx.world, a, 22) || ctx.world.nearestWater?.(a.x, a.y);
      const target =
        own > 0
          ? T(a.x, a.y)
          : well && wd < 28
            ? well
            : spot
              ? beside(ctx.world, spot)
              : null;
      if (!target) return [];
      const u =
        a.body.thirst * (U.thirstBase * 1.4) +
        Math.max(0, a.body.thirst - 0.35) * (U.thirstCrisis * 1.5) +
        (well && wd < 10 ? 2 : 0);
      return [{ kind: 'drink', u, target, dur: 1 }];
    },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) {
        return 'continue';
      }
      if (a.count('water') > 0) {
        a.take('water', 1);
      } else {
        a.add('water', 3);
        a.memory.learn('where:water', {
          kind: 'place',
          confidence: 0.75,
          valence: 0.5,
          payload: { x: act.target.x, y: act.target.y },
        });
        a.memory.learn('water', {
          kind: 'matter', confidence: 0.6, valence: 0.4, source: 'experience',
        });
        if (ctx.world.structureAt?.(a.x, a.y)?.kind === 'well') {
          learnStructureUse(a, 'well', 'vessel', 0.2, 0.45);
        }
      }
      a.body.thirst = clamp(a.body.thirst - 0.8, 0, 1);
      appraise(a, {
        goalCongruence: 0.4, agency: 'self', intensity: 0.3, kind: 'drink',
      });
      return 'done';
    },
  },

  eat: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.hunger < 0.22) return [];
      let best = null;
      for (const key of a.inventory.keys()) {
        const c = ctx.ont.get(key);
        const n = c?.serves?.('sustenance') || c?.functions?.sustenance || 0;
        if (n > (best?.n || 0.15)) best = { key, n, c };
      }
      if (!best) {
        const store = ctx.world
          .structuresOfKind('store')
          .find((s) => {
            if (!s.stock) return false;
            for (const [k, v] of s.stock) {
              if (v <= 0) continue;
              const c = ctx.ont.get(k);
              if ((c?.serves?.('sustenance') || c?.functions?.sustenance || 0) > 0.15) return true;
              if (k === 'water') return true;
            }
            return false;
          });
        if (store) {
          return [{
            kind: 'takeFromStore',
            u: a.body.hunger * U.hungerBase * 1.3 + Math.max(0, a.body.hunger - 0.3) * 14,
            target: store,
            dur: 1,
          }];
        }
        return [];
      }
      const u =
        (a.body.hunger * U.hungerBase * 1.25 +
          Math.max(0, a.body.hunger - 0.22) * U.hungerCrisis * 1.2) *
        (0.55 + best.n) *
        (a.body.hunger > 0.35 ? 3.2 : 1.4);
      return [{ kind: 'eat', u, payload: best.key, dur: 1 }];
    },
    run(a, ctx, act) {
      const c = ctx.ont.get(act.payload);
      if (!c || !a.take(act.payload, 1)) return 'abort';
      const nutrition = c.serves('sustenance');
      a.body.hunger = clamp(a.body.hunger - 0.5 - nutrition * 0.75, 0, 1);
      if (c.props?.toxic > 0.2 && ctx.rng.bool(c.props.toxic * 0.5)) {
        a.body.illness = clamp(a.body.illness + c.props.toxic * 0.5, 0, 1);
        ctx.sim.record(a, 'illness', `${a.name} sickened after eating ${c.word}`, {
          valence: -0.6, intensity: 0.6, concept: act.payload,
        });
        a.memory.learn(act.payload, {
          kind: 'concept', confidence: 0.5, valence: -0.7, source: 'suffering',
        });
      } else {
        a.memory.learn(act.payload, {
          kind: 'concept', confidence: 0.35, valence: 0.5, source: 'experience',
        });
      }
      a.stats.meals++;
      appraise(a, {
        goalCongruence: 0.5, agency: 'self', intensity: 0.35, kind: 'eat', concept: act.payload,
      });
      return 'done';
    },
  },

  takeFromStore: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.hunger < 0.22 && a.body.thirst < 0.4) return [];
      // Prefer a store that still has food or water when those needs are active
      const stores = ctx.world.structuresOfKind('store').filter((s) => s.stock);
      let store = null;
      let best = -1;
      for (const s of stores) {
        let score = 0;
        for (const [k, v] of s.stock) {
          if (v <= 0) continue;
          const c = ctx.ont.get(k);
          const sust = c?.serves?.('sustenance') || c?.functions?.sustenance || 0;
          if (a.body.thirst > 0.3 && (k === 'water' || sust > 0.15)) score += v * 3;
          if (a.body.hunger > 0.22 && sust > 0.15) score += v * (4 + sust);
          score += v * 0.02;
        }
        if (score > best) {
          best = score;
          store = s;
        }
      }
      if (!store || best <= 0) return [];
      const u =
        a.body.hunger * 3.5 +
        Math.max(0, a.body.hunger - 0.35) * 12 +
        a.body.thirst * 2.5 +
        Math.max(0, a.body.thirst - 0.45) * 8;
      return [{ kind: 'takeFromStore', u, target: store, dur: 1 }];
    },
    run(a, ctx, act) {
      if (!stepToward(a, ctx.world, act.target) && dist(a, act.target) > 1.5) {
        return 'continue';
      }
      const s = act.target;
      if (!s?.stock) return 'abort';

      const takeKey = (k) => {
        const have = s.stock.get(k) || 0;
        if (have <= 0) return false;
        s.stock.set(k, Math.max(0, have - 1));
        a.add(k, 1);
        learnStructureUse(a, 'store', 'storage', 0.22, 0.5);
        const nut =
          ctx.ont.get(k)?.serves?.('sustenance') ||
          ctx.ont.get(k)?.functions?.sustenance ||
          0;
        // Eat immediately when drawing food — avoids "took food, starved later"
        if (nut > 0.15 && a.body.hunger > 0.25 && a.take(k, 1)) {
          a.body.hunger = clamp(a.body.hunger - 0.45 - nut * 0.7, 0, 1);
          a.stats.meals = (a.stats.meals || 0) + 1;
        }
        if (k === 'water' && a.body.thirst > 0.3) {
          if (a.take('water', 1)) a.body.thirst = clamp(a.body.thirst - 0.7, 0, 1);
        }
        if (a.body.hunger > 0.3) {
          a.memory.learn('lesson:hunger', {
            kind: 'lesson',
            confidence: 0.35,
            valence: 0.45,
            source: 'survival',
            payload: { do: 'store', what: k },
          });
        }
        ctx.sim.record(
          a,
          'store',
          `${a.name} drew ${ctx.ont.get(k)?.word || k} from the ${s.word}`,
          { valence: 0.2, intensity: 0.2, quiet: true },
        );
        return true;
      };

      // Thirst first
      if (a.body.thirst > 0.35) {
        if (takeKey('water')) return 'done';
        for (const [k, v] of s.stock) {
          if (v > 0 && k !== 'water' && (ctx.ont.get(k)?.functions?.sustenance || 0) > 0.15) {
            if (takeKey(k)) return 'done';
          }
        }
      }
      // Then real food when hungry
      if (a.body.hunger > 0.25) {
        const foods = [];
        for (const [k, v] of s.stock) {
          if (v <= 0) continue;
          const n = ctx.ont.get(k)?.serves?.('sustenance') || ctx.ont.get(k)?.functions?.sustenance || 0;
          if (n > 0.15) foods.push([k, n, v]);
        }
        foods.sort((a, b) => b[1] - a[1]);
        if (foods.length && takeKey(foods[0][0])) return 'done';
      }
      // Last resort: anything
      for (const [k, v] of s.stock) {
        if (v > 0 && takeKey(k)) return 'done';
      }
      return 'abort';
    },
  },

  sleep: {
    category: 'body',
    propose(a, ctx) {
      if (a.body.rest > 0.85 && a.body.energy > 0.7) return [];
      const night = ctx.world.isNight ? 0.35 : 0;
      const need =
        (1 - a.body.rest) * 1.2 + night + (1 - a.body.energy) * 0.4;
      if (need < 0.45) return [];
      const target = a.home ? T(a.home.x, a.home.y) : T(a.x, a.y);
      return [{
        kind: 'sleep',
        u: need * U.sleepNeed,
        target,
        dur: 4 + Math.round(ctx.rng.float(0, 2)),
      }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      a.body.rest = clamp(a.body.rest + 0.2, 0, 1);
      a.body.energy = clamp(a.body.energy + 0.14, 0, 1);
      if (a.home && dist(a, a.home) < 1.5) {
        a.body.warmth = clamp(a.body.warmth + 0.1, 0, 1);
        learnStructureUse(a, 'shelter', 'shelter', 0.12, 0.35);
      }
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
      const hearth = topN(ctx.world.structuresOfKind('hearth'), 1, (s) => -dist(a, s))[0];
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
      if (ctx.world.structureAt?.(a.x, a.y)?.kind === 'hearth') {
        learnStructureUse(a, 'hearth', 'heat', 0.2, 0.45);
      }
      if (--act.dur <= 0) return 'done';
      return 'continue';
    },
  },

  gather: {
    category: 'work',
    propose(a, ctx) {
      const laden = a.carried() > a.carryLimit;
      const out = [];
      const hungry = a.body.hunger > 0.4;
      const known = new Set(
        a.memory.knownKeys('matter').concat([...a.memory.semantic.keys()]),
      );
      const foodKeys = new Set(['berry', 'root', 'grain', 'meat']);
      const scored = [];

      for (const c of ctx.ont.matter()) {
        const sust = c.functions?.sustenance || 0;
        const isFood = sust > 0.15 || foodKeys.has(c.key);
        if (!(known.has(c.key) || a.genome.curiosity > 0.5 || (hungry && isFood))) continue;
        if (laden && !(isFood && hungry)) continue;
        const desire =
          a.desireFor(c.key, ctx.ont, ctx.sim) +
          (hungry && isFood ? a.body.hunger * 1.8 : 0);
        scored.push({ c, desire });
      }

      for (const { c, desire } of topN(scored, 6, (s) => s.desire)) {
        const remembered = a.memory.belief(`where:${c.key}`)?.payload;
        const spot =
          ctx.world.findResource(c.key, a, 18 + a.genome.acuity * 16) ||
          (remembered &&
          ctx.world.bedAt(remembered.x, remembered.y)?.[c.key]?.amount > 1
            ? remembered
            : null);
        if (!spot) continue;
        const travel = dist(a, spot);
        const feedsMe = (c.functions?.sustenance || 0) > 0.15 ? 1 + a.body.hunger * 2.5 : 1;
        const u =
          ((desire * 1.9 * feedsMe * (ctx.bias?.work ?? 1)) / (1 + travel * 0.06)) *
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
        6 + Math.floor((1.4 + a.skills.forage * 4) * ctx.rng.float(0.85, 1.7));
      const got = ctx.world.harvest(act.site.x, act.site.y, act.payload, yieldAmt);
      if (got <= 0) {
        a.memory.learn(`where:${act.payload}`, {
          kind: 'place', confidence: 0.2, valence: -0.3, payload: null,
        });
        return 'abort';
      }
      a.add(act.payload, got);
      a.stats.harvested += got;
      a.gainSkill('forage', a.body.hunger > 0.4 ? 0.06 : 0.02);
      a.memory.learn(`where:${act.payload}`, {
        kind: 'place',
        confidence: 0.7,
        valence: 0.5,
        payload: { x: act.site.x, y: act.site.y },
      });
      a.memory.learn(act.payload, { kind: 'matter', confidence: 0.55, valence: 0.35 });
      a.memory.link(act.payload, 'found-at', `${act.site.x},${act.site.y}`, 0.4);
      if (a.body.hunger > 0.4) {
        a.memory.learn('lesson:hunger', {
          kind: 'lesson',
          confidence: 0.45,
          valence: 0.55,
          source: 'survival',
          payload: { do: 'gather', what: act.payload },
        });
      }
      ctx.sim.record(
        a,
        'gather',
        `${a.name} gathered ${Math.round(got)} ${ctx.ont.get(act.payload)?.word || act.payload}`,
        { valence: 0.25, intensity: 0.2, concept: act.payload, quiet: true },
      );
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
      const u =
        (hungerPull * capability * (ctx.bias?.work ?? 1) * (1 - risk * (1 - a.genome.risk))) /
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
        const got = ctx.world.harvest(act.site.x, act.site.y, 'game', 1 + Math.floor(power));
        if (got <= 0) return 'abort';
        a.add('meat', got * 2);
        a.add('hide', got);
        a.add('bone', got);
        a.stats.harvested += got * 4;
        a.gainSkill('hunt', 0.05);
        ctx.sim.record(a, 'hunt', `${a.name} brought down game on the ${ctx.world.season} ground`, {
          valence: 0.6, intensity: 0.6, concept: 'meat',
        });
        appraise(a, { goalCongruence: 0.7, agency: 'self', intensity: 0.6, kind: 'hunt' });
        for (const k of ['meat', 'hide', 'bone']) {
          a.memory.learn(k, { kind: 'matter', confidence: 0.6, valence: 0.4 });
        }
        if (a.body.hunger > 0.4) {
          a.memory.learn('lesson:hunger', {
            kind: 'lesson', confidence: 0.4, valence: 0.5, source: 'survival',
            payload: { do: 'hunt', what: 'meat' },
          });
        }
      } else {
        const hurt = ctx.rng.float(0.05, 0.3) / Math.max(0.2, a.genome.resilience);
        a.body.injury = clamp(a.body.injury + hurt, 0, 1);
        const idx = ctx.world.idx(act.site.x, act.site.y);
        if (ctx.world.danger) {
          ctx.world.danger[idx] = clamp((ctx.world.danger[idx] || 0) + 0.3, 0, 1);
        }
        ctx.sim.record(a, 'injury', `${a.name} was hurt hunting and came back with nothing`, {
          valence: -0.7, intensity: 0.7,
        });
        appraise(a, {
          goalCongruence: -0.6, agency: 'world', intensity: 0.7, kind: 'injury', certainty: 0.4,
        });
      }
      return 'done';
    },
  },

  craft: {
    category: 'work',
    propose(a, ctx) {
      if (a.body.hunger > 0.55) return [];
      if (a.carried() > a.carryLimit * 0.95) return [];
      const out = [];
      const hungryHousehold =
        a.body.hunger > 0.35 || ctx.sim.totalFood() < ctx.sim.living.length * 2;
      const shopBoost =
        typeof ctx.world.hasStructureNear === 'function' &&
        ctx.world.hasStructureNear(a.x, a.y, 'workshop', 5)
          ? 1.15
          : 1;
      let looked = 0;
      for (const key of a.memory.knownKeys('recipe')) {
        if (++looked > 24) break;
        const c = ctx.ont.get(key);
        if (!c) continue;
        if (!c.parents.every((p) => availableMaterial(a, ctx, p) >= 1)) continue;
        if (
          hungryHousehold &&
          !c.functions.sustenance &&
          c.parents.some((p) => (ctx.ont.get(p)?.serves('sustenance') || 0) > 0.2)
        ) {
          continue;
        }
        const desire = a.desireFor(key, ctx.ont, ctx.sim);
        const craftNorm = normsFor(a, ctx, ['craft', 'invention']);
        out.push({
          kind: 'craft',
          u:
            desire *
            1.3 *
            (ctx.bias?.work ?? 1) *
            (0.5 + a.skills.craft) *
            (1 + Math.max(0, craftNorm) * 0.25) *
            shopBoost,
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
        if (takeMaterial(a, ctx, p, 1) < 1) return 'abort';
      }
      a.add(act.payload, 1);
      c.uses++;
      a.stats.crafted++;
      a.gainSkill('craft', 0.035);
      a.body.energy = clamp(a.body.energy - 0.07, 0, 1);
      if (ctx.world.hasStructureNear?.(a.x, a.y, 'workshop', 5)) {
        learnStructureUse(a, 'workshop', 'cutting', 0.15, 0.4);
      }
      ctx.sim.record(a, 'craft', `${a.name} made ${c.word}`, {
        valence: 0.4, intensity: 0.35, concept: c.key, quiet: true,
      });
      appraise(a, { goalCongruence: 0.45, agency: 'self', intensity: 0.4, kind: 'craft' });
      return 'done';
    },
  },

  experiment: {
    category: 'thought',
    propose(a, ctx) {
      if (a.body.hunger > 0.45 || a.body.thirst > 0.5 || a.body.energy < 0.25) return [];
      const owned = [...a.inventory.keys()].filter((k) => ctx.ont.get(k));
      if (owned.length < 1) return [];
      const u =
        (0.55 + a.genome.curiosity * 1.9) *
        (ctx.bias?.explore ?? 1) *
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
      const short = a.body.hunger > 0.4;
      const weight = (k) => {
        const c = ctx.ont.get(k);
        let w = 0.3 + (a.memory.belief(k)?.confidence || 0) * 0.6;
        if (short && c.serves('sustenance') > 0.2) w *= 0.05;
        for (const g of gaps) {
          w += (c.functions[g] || 0) * 1.5 + (c.props.hard + c.props.flexible) * 0.1;
        }
        return w;
      };
      const aKey = ctx.rng.weighted
        ? ctx.rng.weighted(owned.map((k) => [k, weight(k)]))
        : ctx.rng.pick(owned);
      const bKey = ctx.rng.bool(0.78)
        ? (ctx.rng.weighted
            ? ctx.rng.weighted(owned.map((k) => [k, weight(k)]))
            : ctx.rng.pick(owned))
        : null;
      const proc = ctx.rng.weighted
        ? ctx.rng.weighted(
            procs.map((p) => [p, 1 + (a.memory.belief(`proc:${p}`)?.confidence || 0) * 1.5]),
          )
        : ctx.rng.pick(procs);

      const isFood = (k) => (ctx.ont.get(k)?.serves('sustenance') || 0) > 0.15;
      if (a.body.hunger > 0.4 && (isFood(aKey) || (bKey && isFood(bKey)))) {
        return 'abort';
      }

      a.memory.learn(`proc:${proc}`, { kind: 'process', confidence: 0.08, valence: 0 });
      const res = ctx.ont.attempt(a, aKey, bKey && bKey !== aKey ? bKey : null, proc);
      a.stats.ideas++;
      a.body.energy = clamp(a.body.energy - 0.06, 0, 1);
      a.gainSkill('craft', 0.02);
      if (!res.ok) {
        if (res.reason === 'known' && res.concept) {
          a.memory.learn(res.concept.key, {
            kind: 'recipe', confidence: 0.5, valence: 0.2, source: 'rediscovery',
          });
        } else {
          appraise(a, {
            goalCongruence: -0.15, agency: 'self', intensity: 0.2, kind: 'failure',
          });
        }
        return 'done';
      }
      const c = res.concept;
      for (const p of c.parents) a.take(p, 1);
      a.add(c.key, 1);
      a.memory.learn(c.key, {
        kind: 'recipe', confidence: 0.85, valence: 0.7, source: 'invention',
      });
      for (const p of c.parents) a.memory.link(p, 'combines-into', c.key, 0.6);
      a.memory.link(c.key, 'serves', c.bestFn, 0.7);
      a.stats.inventions++;
      a.gainSkill('craft', 0.05);
      const proud = res.advance ? 0.95 : 0.35;
      appraise(a, {
        goalCongruence: proud, agency: 'self', intensity: proud, novelty: 1, kind: 'invention',
      });
      ctx.sim.onInvention(a, res.record, c);
      return 'done';
    },
  },

  build: {
    category: 'work',
    propose(a, ctx) {
      if (a.isChild(ctx.world.tick)) return [];
      if (a.body.hunger > 0.72) return [];
      const foodEasy =
        a.body.hunger < 0.4 && ctx.sim.totalFood() > ctx.sim.living.length * 1.5;
      const hungry = a.body.hunger > 0.4;
      const settlement = ctx.sim.nearestSettlement(a.x, a.y);
      const s = ctx.sim.settlementNeeds(settlement);
      const people = s.people || 1;
      const out = [];

      const nearCount = (kind) =>
        ctx.world.structuresOfKind(kind).filter(
          (st) => Math.hypot(st.x - settlement.x, st.y - settlement.y) < 16,
        ).length;

      const fieldsNear = nearCount('field');
      const foodTight = ctx.sim.totalFood() < people * 3;
      const needFieldBoost =
        (hungry || foodTight) && fieldsNear < 1
          ? 0.9
          : (hungry || foodTight) && fieldsNear < Math.ceil(people / 8)
            ? 0.55
            : foodTight && fieldsNear < 2
              ? 0.4
              : 0;

      const far = ctx.sim.farBankTarget?.(a, 22);

      for (const [kind, def] of Object.entries(STRUCTURE_KINDS)) {
        // ── Bridge: full span cost + site ───────────────────────
        if (kind === 'bridge') {
          const spans =
            ctx.world.bridgeSpanCount?.(settlement.x, settlement.y, 18) ??
            nearCount('bridge');
          if (spans >= 2) continue;

          const span = ctx.world.findBridgeSpan?.(settlement.x, settlement.y, 26, 8);
          if (!span?.tiles?.length) continue;

          let need = def.need(s);
          if (far) need = Math.max(need, 0.75);
          else need = Math.max(need, 0.5);
          if (need <= 0.08) continue;

          const purpose =
            spans === 0
              ? 0.65 + a.genome.curiosity * 0.55
              : knownStructureUse(a, 'bridge');

          let matKey = 'wood';
          for (const k of ['wood', 'stone', 'fibre', 'reed', 'clay']) {
            if (availableMaterial(a, ctx, k) >= 1) {
              matKey = k;
              break;
            }
          }
          const cost = Math.max(3, span.length * 2);
          if (availableMaterial(a, ctx, matKey) < cost) {
            const spot = ctx.world.findResource(matKey, a, 18);
            if (spot && a.carried() <= a.carryLimit) {
              out.push({
                kind: 'gather',
                u: need * purpose * 1.3 * (0.5 + a.genome.industry) * (ctx.bias?.work ?? 1),
                payload: matKey,
                target: beside(ctx.world, spot),
                site: spot,
                dur: 2,
              });
            }
            continue;
          }

          out.push({
            kind: 'build',
            u:
              need *
              purpose *
              1.6 *
              (ctx.bias?.work ?? 1) *
              (0.5 + a.genome.industry) *
              (far ? 1.4 : 1),
            payload: {
              structure: 'bridge',
              material: matKey,
              cost,
              fn: def.fn,
              settlement,
              span,
            },
            dur: 3 + span.length,
          });
          continue;
        }

        // ── Other structures ────────────────────────────────────
        let need = def.need(s);
        const existing = nearCount(kind);
        const cap = structureCap(kind, people);
        if (cap <= 0 || existing >= cap) continue;
        if (!structureUnlocked(kind, ctx, settlement, nearCount)) continue;
        if (!settlementBuildAllowed(ctx, settlement, kind)) continue;

        if (kind === 'shelter' && existing < Math.max(1, Math.ceil(people / 2.5))) {
          need = Math.max(need, 0.5);
        }
        if (kind === 'store' && existing < Math.max(1, Math.ceil(people / 14))) {
          need = Math.max(need, 0.45);
        }
        if (kind === 'hearth' && existing < 1) need = Math.max(need, 0.4);
        if (kind === 'field') {
          need = Math.max(need, needFieldBoost);
          if (existing < 1) need = Math.max(need, 0.5);
          if (existing < Math.ceil(people / 7)) need = Math.max(need, 0.35);
          if (foodEasy && existing < Math.ceil(people / 9)) need = Math.max(need, 0.32);
        }
        // First copy of institutions matters; extras are capped above
        if (kind === 'workshop' && existing < 1 && people >= 8) {
          need = Math.max(need, foodEasy ? 0.65 : 0.38);
        }
        if (kind === 'market' && existing < 1 && people >= 10) {
          need = Math.max(need, foodEasy ? 0.6 : 0.32);
        }
        if (kind === 'hall' && existing < 1 && people >= 12) {
          need = Math.max(need, foodEasy ? 0.55 : 0.28);
        }
        if (kind === 'plaza' && existing < 1 && people >= 10) {
          need = Math.max(need, foodEasy ? 0.5 : 0.25);
        }
        if (kind === 'shrine' && existing < 1) {
          const corpses = ctx.world.corpses?.length || 0;
          if (people >= 10 || corpses >= 2) {
            need = Math.max(need, 0.45 + Math.min(0.25, corpses * 0.06));
          }
        }
        if (kind === 'well' && existing < 1 && people >= 8) need = Math.max(need, 0.38);
        if (kind === 'path' && existing < cap && people >= 8) need = Math.max(need, 0.28);

        // Diminishing returns: 2nd copy much weaker than 1st
        need *= 1 / (1 + existing * 1.15);
        // Household pressure: more households than shelters
        if (kind === 'shelter') {
          const hh = ctx.sim.households?.length || 0;
          if (hh > existing) need = Math.max(need, Math.min(0.55, 0.2 + (hh - existing) * 0.12));
        }

        if (need <= 0.07) continue;

        const purpose =
          existing === 0
            ? 0.65 + a.genome.curiosity * 0.55
            : knownStructureUse(a, kind);

        const material = ctx.sim.bestBuildMaterial(a, def.fn);
        let matKey = material?.key;
        let matScore = material?.score || 0;
        if (!matKey || availableMaterial(a, ctx, matKey) < 1) {
          for (const k of ['wood', 'stone', 'clay', 'fibre', 'reed']) {
            if (availableMaterial(a, ctx, k) >= 1) {
              matKey = k;
              matScore = 0.25;
              break;
            }
          }
        }
        if (!matKey) continue;

        const cost = Math.ceil(def.cost / (0.5 + matScore));
        if (availableMaterial(a, ctx, matKey) < cost) {
          const spot = ctx.world.findResource(matKey, a, 16);
          if (spot && a.carried() <= a.carryLimit) {
            out.push({
              kind: 'gather',
              u: need * purpose * 1.2 * (0.5 + a.genome.industry) * (ctx.bias?.work ?? 1),
              payload: matKey,
              target: beside(ctx.world, spot),
              site: spot,
              dur: 2,
            });
          }
          continue;
        }

        const institution =
          kind === 'workshop' || kind === 'market' || kind === 'hall' ||
          kind === 'plaza' || kind === 'shrine';
        const u =
          need *
          purpose *
          1.55 *
          (ctx.bias?.work ?? 1) *
          (0.6 + a.skills.build * 0.5) *
          (0.5 + a.genome.industry) *
          (foodEasy ? (institution ? 1.35 : 1.2) : 1) *
          (hungry && kind === 'field' ? 1.6 : 1);

        out.push({
          kind: 'build',
          u,
          payload: {
            structure: kind,
            material: matKey,
            cost,
            fn: def.fn,
            settlement,
          },
          dur: 4 + Math.round(def.cost / 3),
        });
      }
      return topN(out, 3, (o) => o.u);
    },
    run(a, ctx, act) {
      const structure = act.payload.structure;

      if (!act.spot) {
        act.spot = ctx.sim.pickBuildSite(a, structure, act.payload.settlement);
      }
      if (!act.spot) return 'abort';

      // Approach dry land next to the span (or the build tile)
      const approach =
        structure === 'bridge' && act.payload.span?.startLand
          ? act.payload.span.startLand
          : act.spot;

      if (dist(a, approach) > 1.4) {
        stepToward(a, ctx.world, approach);
        return 'continue';
      }

      a.body.energy = clamp(a.body.energy - 0.05, 0, 1);
      if (--act.dur > 0) return 'continue';

      const { material } = act.payload;
      let needMat = act.payload.cost;

      if (structure === 'bridge') {
        const span =
          act.payload.span ||
          ctx.world.findBridgeSpan?.(act.spot.x, act.spot.y, 26, 8) ||
          ctx.world.findBridgeSpan?.(
            act.payload.settlement.x,
            act.payload.settlement.y,
            26,
            8,
          );
        if (!span?.tiles?.length) return 'abort';
        needMat = Math.max(3, span.length * 2);
        act.payload.span = span;
        act.spot = { x: span.tiles[0].x, y: span.tiles[0].y, span };
      }

      if (takeMaterial(a, ctx, material, needMat) < needMat) return 'abort';
      const st = ctx.sim.raiseStructure(a, structure, act.spot, material);
      if (!st) return 'abort';

      a.stats.built++;
      a.gainSkill('build', 0.07);
      noteSettlementBuild(ctx, act.payload.settlement, structure);
      learnStructureUse(
        a,
        structure,
        STRUCTURE_KINDS[structure]?.fn || structure,
        0.12,
        0.3,
      );
      if (structure === 'bridge') {
        learnStructureUse(a, 'bridge', 'crossing', 0.2, 0.45);
      }
      if (structure === 'field') {
        st.tended = (st.tended || 0) + 0.3;
        st.ripeness = Math.max(st.ripeness || 0, 0.15);
      }
      appraise(a, { goalCongruence: 0.8, agency: 'self', intensity: 0.7, kind: 'first' });
      if (!a.home && structure === 'shelter') a.home = st;
      return 'done';
    },
  },

  expand: {
    category: 'work',
    propose(a, ctx) {
      if (a.isChild(ctx.world.tick) || a.ageAt(ctx.world.tick) < 16) return [];
      if (a.body.hunger > 0.6) return [];
      const home = ctx.sim.nearestSettlement(a.x, a.y);
      const pressure = ctx.sim.settlementPressure(home);
      if (pressure < 0.35) return [];
      const known = a.memory
        .knownKeys('place')
        .map((k) => a.memory.belief(k))
        .filter((b) => b?.payload);
      let best = null;
      let bestScore = 0;
      for (const belief of known) {
        const p = belief.payload;
        const nearestD = Math.min(...ctx.sim.settlements.map((s) => dist(p, s)));
        if (nearestD < 24) continue;
        const score =
          clamp(belief.confidence) *
          (0.4 + clamp(belief.valence, 0, 1)) *
          Math.min(1, nearestD * 0.02);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (!best) return [];
      const u =
        pressure *
        (0.4 + a.genome.risk + a.genome.industry * 0.5) *
        (ctx.bias?.work ?? 1) *
        (0.3 + bestScore);
      if (u < 0.4) return [];
      return [{ kind: 'expand', u, target: T(best.x, best.y), dur: 1 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.4) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      ctx.sim.foundSettlement(a, act.target);
      return 'done';
    },
  },

  farm: {
    category: 'work',
    propose(a, ctx) {
      const fields = ctx.world.structuresOfKind('field');
      if (!fields.length) return [];
      const f = topN(fields, 1, (s) => {
        const place = a.memory.belief('where:field-works')?.payload;
        const placeBoost = place && place.x === s.x && place.y === s.y ? 0.5 : 0;
        return (s.ripeness || 0) * 3 + placeBoost - dist(a, s) * 0.04;
      })[0];
      if (!f) return [];
      const ripe = f.ripeness || 0;
      const purpose = knownStructureUse(a, 'field');
      const hungry = a.body.hunger > 0.38;
      const hungerFarm =
        hungry && ripe > 0.7
          ? 2.5 + a.body.hunger * 4
          : ripe > 0.85
            ? 1.6 + a.body.hunger
            : 0.35 * purpose;
      const u =
        (hungerFarm * (ctx.bias?.work ?? 1) * (0.45 + a.skills.farm) * Math.max(0.5, purpose)) /
        (1 + dist(a, f) * 0.04);
      return [{ kind: 'farm', u, target: T(f.x, f.y), field: f, dur: 2 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      const f = act.field;
      if ((f.ripeness || 0) > 0.85) {
        const got =
          2 +
          Math.round(
            a.skills.farm * 5 + (ctx.world.fertility?.[ctx.world.idx(f.x, f.y)] || 0.5) * 4,
          );
        a.add('grain', got);
        f.ripeness = 0;
        f.harvests = (f.harvests || 0) + 1;
        a.stats.harvested += got;
        a.gainSkill('farm', 0.05);
        const fi = ctx.world.idx(f.x, f.y);
        if (ctx.world.fertility) {
          ctx.world.fertility[fi] = clamp(ctx.world.fertility[fi] - 0.04, 0.15, 1);
        }

        learnStructureUse(a, 'field', 'sustenance', 0.28, 0.55);
        a.memory.learn('where:field-works', {
          kind: 'place',
          confidence: 0.45,
          valence: 0.5,
          payload: { x: f.x, y: f.y },
        });
        a.memory.learn('grain', {
          kind: 'matter', confidence: 0.5, valence: 0.5, source: 'farm',
        });

        ctx.sim.record(
          a,
          'harvest',
          `${a.name} took ${Math.round(got)} ${ctx.ont.get('grain')?.word || 'grain'} from the ${f.word}`,
          { valence: 0.6, intensity: 0.5, concept: 'grain' },
        );
        if ((a.memory.belief('structure:field')?.confidence || 0) < 0.45) {
          ctx.sim.record(
            a,
            'thought',
            `${a.name} saw that the turned ground gives food`,
            { valence: 0.4, intensity: 0.35, voice: a.name },
          );
        }
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
      if (a.body.hunger > 0.55) return [];
      const stores = ctx.world.structuresOfKind('store');
      if (!stores.length) return [];
      let surplus = 0;
      for (const [k, v] of a.inventory) {
        const c = ctx.ont.get(k);
        if (c?.functions.sustenance && v > 3) surplus += v - 3;
      }
      if (surplus < 2) return [];
      const s = topN(stores, 1, (x) => -dist(a, x))[0];
      const purpose = knownStructureUse(a, 'store');
      const u =
        surplus * 0.16 * purpose * (0.5 + a.genome.patience) * (ctx.bias?.hoard ?? 1);
      return [{ kind: 'store', u, target: T(s.x, s.y), store: s, dur: 1 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
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
      if (moved) {
        learnStructureUse(a, 'store', 'storage', 0.2, 0.45);
        ctx.sim.record(
          a,
          'store',
          `${a.name} laid ${Math.round(moved)} measures of food into the ${act.store.word}`,
          { valence: 0.35, intensity: 0.3, quiet: true },
        );
      }
      return 'done';
    },
  },

  converse: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 6).filter((o) => o.id !== a.id);
      if (!near.length) return [];
      const out = [];
      const boost = plazaBoost(ctx, a, 1.25);
      for (const o of near.slice(0, 4)) {
        const r = a.rel(o);
        const lonely = 1 - clamp(r.familiarity);
        const u =
          ((0.2 + a.genome.sociability * 0.8) *
            (ctx.bias?.social ?? 1) *
            (1 - a.body.hunger * 0.6) *
            (0.4 + lonely * 0.6 + r.affection * 0.5 + a.genome.expressive * 0.3) *
            boost) /
          (1 + dist(a, o) * 0.12);
        out.push({ kind: 'converse', u, targetId: o.id, dur: 2 });
      }
      return topN(out, 2, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      ctx.sim.converse(a, o);
      if (ctx.rng.bool(0.25)) {
        for (const kind of ['field', 'store', 'bridge', 'shelter', 'hearth']) {
          const b = a.memory.belief(`structure:${kind}`);
          if (b && b.confidence > 0.25 && !o.memory.knows(`structure:${kind}`, 0.2)) {
            o.memory.learn(`structure:${kind}`, {
              kind: 'lesson',
              confidence: b.confidence * 0.45 * (o.genome.learning || 0.5),
              valence: b.valence,
              source: `told by ${a.name}`,
              payload: b.payload,
            });
            break;
          }
        }
      }
      if (--act.dur > 0) return 'continue';
      return 'done';
    },
  },

  teach: {
    category: 'social',
    propose(a, ctx) {
      if (a.body.hunger > 0.4 || a.body.thirst > 0.55) return [];
      if (ctx.sim.totalFood() < ctx.sim.living.length * 1.5) return [];

      const near = ctx.nearby(a, 6).filter((o) => o.id !== a.id);
      if (!near.length) return [];

      const mine = a.memory.knownKeys('recipe');
      const structureLessons = [
        'field', 'store', 'bridge', 'shelter', 'hearth', 'workshop',
        'market', 'hall', 'plaza', 'shrine',
      ]
        .map((k) => `structure:${k}`)
        .filter((k) => a.memory.knows(k, 0.25));

      if (!mine.length && !structureLessons.length) return [];

      const teachNorm = normsFor(a, ctx, ['teaching', 'teach']);
      const hallBoost = structureBoost(ctx, a, ['hall', 'plaza'], 1.45);
      const out = [];

      for (const o of near) {
        const candidates = [];
        for (const k of mine) {
          if (o.memory.knows(k, 0.3)) continue;
          const holders = ctx.sim.living.filter(
            (x) => x.id !== a.id && x.memory.knows(k, 0.25),
          ).length;
          candidates.push({ key: k, rarity: 1 / Math.max(1, holders), isStructure: false });
        }
        for (const k of structureLessons) {
          if (o.memory.knows(k, 0.25)) continue;
          candidates.push({ key: k, rarity: 1.2, isStructure: true });
        }
        if (!candidates.length) continue;

        candidates.sort((x, y) => y.rarity - x.rarity);
        const pick = candidates[0];

        const kinBonus = a.children.includes(o.id) ? 1.5 : 0;
        const childBonus = o.isChild(ctx.world.tick) ? 1.35 : 1;
        const elderBonus = a.isElder(ctx.world.tick) ? 1.4 : 1;

        const u =
          (0.35 + a.genome.empathy * 0.9 + kinBonus) *
          (ctx.bias?.social ?? 1) *
          (0.45 + a.skills.teach) *
          elderBonus *
          childBonus *
          (1 + pick.rarity * 2) *
          (1 + Math.max(0, teachNorm) * 0.35) *
          hallBoost;

        out.push({
          kind: 'teach',
          u,
          targetId: o.id,
          payload: pick.key,
          structureLesson: pick.isStructure,
          dur: 3,
        });
      }
      return topN(out, 2, (x) => x.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';

      if (act.structureLesson || String(act.payload).startsWith('structure:')) {
        const b = a.memory.belief(act.payload);
        if (b) {
          o.memory.learn(act.payload, {
            kind: 'lesson',
            confidence: Math.min(0.7, (b.confidence || 0.4) * 0.6 * (o.genome.learning || 0.5)),
            valence: b.valence ?? 0.4,
            source: `taught by ${a.name}`,
            payload: b.payload,
          });
          a.stats.taught = (a.stats.taught || 0) + 1;
          o.stats.learned = (o.stats.learned || 0) + 1;
          ctx.sim.counters.lessons++;
          const kind = act.payload.replace('structure:', '');
          ctx.sim.record(
            a,
            'teach',
            `${a.name} taught ${o.name} what a ${kind} is for`,
            { actors: [a.id, o.id], valence: 0.4, intensity: 0.4 },
          );
        }
        return 'done';
      }

      ctx.sim.teach(a, o, act.payload);
      return 'done';
    },
  },

  trade: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 7).filter((o) => o.id !== a.id && !o.isChild(ctx.world.tick));
      const out = [];
      const boost = plazaBoost(ctx, a, 1.2);
      for (const o of near) {
        const r = a.rel(o);
        if (ctx.world.tick - (r.lastTrade || -999) < 30) continue;
        const deal = ctx.sim.findDeal(a, o);
        if (!deal) continue;
        out.push({
          kind: 'trade',
          u:
            deal.gain *
            0.6 *
            (0.5 + r.trust) *
            (0.5 + a.skills.trade + a.genome.sociability * 0.5) *
            boost,
          targetId: o.id,
          deal,
          dur: 2,
        });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';
      ctx.sim.settleTrade(a, o, act.deal);
      return 'done';
    },
  },

  give: {
    category: 'social',
    propose(a, ctx) {
      const near = ctx.nearby(a, 6).filter((o) => o.id !== a.id);
      const shareNorm = normsFor(a, ctx, ['sharing', 'gift', 'neglect']);
      const out = [];
      const tick = ctx.world.tick;
      for (const o of near) {
        const r = a.rel(o);
        // At most one counted gift per pair per half-day
        if (tick - (r.lastGiftTick || -999) < 12) continue;

        const isKid = o.isChild(tick);
        const kinChild =
          isKid &&
          (r.kin > 0.25 ||
            a.household === o.household ||
            a.children.includes(o.id));

        const theirNeed =
          o.body.hunger * 1.6 +
          o.body.thirst * 0.8 +
          o.body.illness +
          (kinChild ? 0.8 : 0);
        if (theirNeed < (kinChild ? 0.25 : 0.55)) continue;
        if (a.body.hunger > (kinChild ? 0.78 : 0.55)) continue;

        let gift = null;
        for (const [k, v] of a.inventory) {
          const c = ctx.ont.get(k);
          if (!c) continue;
          if (
            (o.body.hunger > 0.35 || kinChild) &&
            c.functions.sustenance &&
            v > (kinChild ? 0 : 1)
          ) {
            gift = k;
            break;
          }
          if (o.body.thirst > 0.4 && k === 'water' && v > 0) {
            gift = k;
            break;
          }
          if (o.body.illness > 0.3 && c.functions.medicine && v > 0) {
            gift = k;
            break;
          }
        }
        if (!gift) continue;

        const u =
          theirNeed *
          (a.genome.empathy * 1.5 +
            r.affection * 1.2 +
            r.kin * 1.8 +
            (kinChild ? 1.5 : 0) +
            (r.debt < 0 ? 0.6 : 0)) *
          (ctx.bias?.social ?? 1) *
          (1 + Math.max(0, shareNorm) * 0.5) *
          (kinChild ? 2.0 : 1);

        out.push({
          kind: 'give',
          u,
          targetId: o.id,
          payload: gift,
          dur: 1,
          quietGift: !!kinChild,
        });
      }
      return topN(out, 1, (x) => x.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.6) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      if (!a.take(act.payload, 1)) return 'abort';
      o.add(act.payload, 1);

      const r = a.rel(o);
      r.lastGiftTick = ctx.world.tick;
      r.exchanges = (r.exchanges || 0) + 1;
      const ro = o.rel(a);
      ro.exchanges = (ro.exchanges || 0) + 1;
      ro.lastGiftTick = ctx.world.tick;

      const word = ctx.ont.get(act.payload)?.word || act.payload;
      a.adjustRel(o, { affection: 0.08, familiarity: 0.06, debt: -0.4 });
      o.adjustRel(a, { affection: 0.16, trust: 0.14, familiarity: 0.08, debt: 0.5 });

      if (!act.quietGift) {
        a.stats.gifts++;
        ctx.sim.counters.gifts++;
        ctx.sim.record(a, 'gift', `${a.name} gave ${word} to ${o.name}, who had none`, {
          valence: 0.6,
          intensity: 0.55,
          actors: [a.id, o.id],
        });
        ctx.sim.reputationDelta?.(a, 0.05);
      } else {
        ctx.sim.record(a, 'gift', `${a.name} fed ${o.name}`, {
          valence: 0.35,
          intensity: 0.25,
          actors: [a.id, o.id],
          quiet: true,
        });
      }

      appraise(a, {
        goalCongruence: 0.4, agency: 'self', intensity: 0.45, kind: 'gift', norm: 1, social: o.id,
      });
      appraise(o, {
        goalCongruence: 0.7, agency: 'other', intensity: 0.6, kind: 'gift', social: a.id,
      });
      a.memory.learn('norm:sharing', {
        kind: 'norm', confidence: 0.2, valence: 0.45, source: 'experience',
        payload: { situation: 'sharing', polarity: 1, evidence: 1 },
      });
      return 'done';
    },
  },

  steal: {
    category: 'social',
    propose(a, ctx) {
      const desperate = a.body.hunger > 0.75 || a.body.illness > 0.5;
      if (!desperate && a.genome.empathy > 0.35) return [];
      const near = ctx.nearby(a, 5).filter((o) => o.id !== a.id && o.carried() > 2);
      const theftNorm = normsFor(a, ctx, ['theft', 'betrayal', 'neglect']);
      const out = [];
      for (const o of near) {
        const u =
          (a.body.hunger * 1.5 + (1 - a.genome.empathy)) *
            (1 + theftNorm) *
            (0.4 + a.genome.risk) -
          a.rel(o).affection;
        if (u <= 0.2) continue;
        out.push({ kind: 'steal', u, targetId: o.id, dur: 1 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
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
      const age = a.ageAt(ctx.world.tick);
      if (age < 15 || age > 55 || a.partner) return [];
      const near = ctx.nearby(a, 12).filter(
        (o) =>
          o.id !== a.id &&
          !o.partner &&
          o.ageAt(ctx.world.tick) > 15 &&
          o.ageAt(ctx.world.tick) < 55 &&
          a.rel(o).kin < 0.5,
      );
      const out = [];
      for (const o of near) {
        const r = a.rel(o);
        const u =
          (0.4 +
            r.affection * 1.6 +
            r.familiarity * 1.2 +
            a.genome.fertility * 0.9 +
            a.genome.sociability * 0.5 +
            a.affect.e.love * 0.5) *
          (ctx.bias?.social ?? 1);
        if (u < 0.18) continue;
        out.push({ kind: 'court', u, targetId: o.id, dur: 3 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive || o.partner) return 'abort';
      if (dist(a, o) > 1.4) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      a.adjustRel(o, { affection: 0.18, familiarity: 0.12 });
      o.adjustRel(a, { affection: 0.15, familiarity: 0.12 });
      a.lastCourtTarget = { id: o.id, tick: ctx.world.tick };
      if (--act.dur > 0) return 'continue';
      ctx.sim.tryBond(a, o);
      return 'done';
    },
  },

  fight: {
    category: 'social',
    propose(a, ctx) {
      if (a.affect.e.anger < 0.45) return [];
      if (ctx.world.tick - (a.lastFightTick || -999) < 60) return [];
      const near = ctx.nearby(a, 4).filter((o) => o.id !== a.id);
      const violenceNorm = normsFor(a, ctx, ['violence', 'injury']);
      const out = [];
      for (const o of near) {
        const r = a.rel(o);
        if (r.kin > 0.5 || r.affection > 0.15) continue;
        const grudge = clamp(-r.affection) + Math.min(0.35, r.conflicts * 0.07);
        const u =
          (a.affect.e.anger * 1.1 + grudge * 0.9) *
          (0.15 + a.genome.aggression * 1.2) *
          (ctx.bias?.aggress ?? 1) *
          (1 - a.genome.empathy * 0.7) *
          (1 + violenceNorm * 1.2);
        if (u < 0.95) continue;
        out.push({ kind: 'fight', u, targetId: o.id, dur: 1 });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      ctx.sim.resolveFight(a, o);
      return 'done';
    },
  },

  follow: {
    category: 'social',
    propose(a, ctx) {
      const age = a.ageAt(ctx.world.tick);
      let leader = null;
      let weight = 0;

      if (age < 11) {
        for (const id of [a.motherId, a.fatherId]) {
          const p = id && ctx.sim.byId(id);
          if (p && p.alive) {
            leader = p;
            weight = 2.4 - age * 0.12;
            break;
          }
        }
        if (!leader) {
          const adults = ctx.nearby(a, 20).filter(
            (o) => o.id !== a.id && !o.isChild(ctx.world.tick),
          );
          if (adults.length) {
            leader = adults.sort((x, y) => dist(a, x) - dist(a, y))[0];
            weight = 1.6;
          }
        }
      } else if (a.partner) {
        const p = ctx.sim.byId(a.partner);
        if (p && p.alive) {
          const d = dist(a, p);
          if (d < 8) return [];
          leader = p;
          weight = 0.25 + a.rel(p).affection * 0.35;
        }
      }

      if (!leader) return [];
      const d = dist(a, leader);
      if (d < 3) return [];
      return [{ kind: 'follow', u: weight * Math.min(1.4, d * 0.12), targetId: leader.id, dur: 1 }];
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
      const near = ctx.nearby(a, 6).filter(
        (o) => o.id !== a.id && (o.body.illness > 0.3 || o.body.injury > 0.3),
      );
      const rescueNorm = normsFor(a, ctx, ['rescue', 'care']);
      const out = [];
      const remedy = a.bestToolFor('medicine', ctx.ont);
      for (const o of near) {
        const r = a.rel(o);
        const u =
          (o.body.illness + o.body.injury) *
          (a.genome.empathy * 1.4 + r.kin * 1.2 + r.affection) *
          (0.4 + a.skills.heal + (remedy ? remedy.score : 0)) *
          (1 + Math.max(0, rescueNorm) * 0.4);
        out.push({
          kind: 'care',
          u,
          targetId: o.id,
          payload: remedy?.key || null,
          dur: 2,
        });
      }
      return topN(out, 1, (o) => o.u);
    },
    run(a, ctx, act) {
      const o = ctx.sim.byId(act.targetId);
      if (!o || !o.alive) return 'abort';
      if (dist(a, o) > 1.4) {
        stepToward(a, ctx.world, T(o.x, o.y));
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';
      const remedyPower = act.payload
        ? ctx.ont.get(act.payload)?.serves('medicine') || 0
        : 0;
      const heal = 0.12 + a.skills.heal * 0.4 + remedyPower * 0.6;
      const before = o.body.illness + o.body.injury;
      o.body.illness = clamp(o.body.illness - heal, 0, 1);
      o.body.injury = clamp(o.body.injury - heal, 0, 1);
      if (act.payload) a.take(act.payload, 1);
      a.gainSkill('heal', 0.06);
      a.stats.rescues++;
      o.adjustRel(a, { trust: 0.2, affection: 0.18, debt: 0.6 });
      a.adjustRel(o, { affection: 0.1, familiarity: 0.08 });
      ctx.sim.record(
        a,
        'rescue',
        `${a.name} tended ${o.name}${act.payload ? ` with ${ctx.ont.get(act.payload)?.word}` : ''}`,
        { valence: 0.6, intensity: 0.6, actors: [a.id, o.id] },
      );
      appraise(o, {
        goalCongruence: clamp(before, 0, 1),
        agency: 'other',
        intensity: 0.6,
        kind: 'rescue',
        social: a.id,
      });
      if (remedyPower > 0.2) {
        a.memory.learn(act.payload, {
          kind: 'recipe', confidence: 0.3, valence: 0.6, source: 'healing',
        });
      }
      return 'done';
    },
  },

  bury: {
    category: 'ritual',
    propose(a, ctx) {
      if (!ctx.world.corpses?.length) return [];
      if (a.isChild(ctx.world.tick)) return [];
      const c = topN(ctx.world.corpses, 1, (k) => -dist(a, k))[0];
      if (!c || dist(a, c) > 28) return [];
      const r = a.rel(c.id) || { kin: 0, affection: 0 };
      const burialNorm = normsFor(a, ctx, ['burial', 'ritual', 'death']);
      // Unburied dead are urgent: boost so burial norm can be upheld
      const backlog = Math.min(4, ctx.world.corpses.length);
      const u =
        (0.85 + a.genome.empathy + r.kin * 1.5 + r.affection + (a.affect.e.grief || 0)) *
        1.6 *
        (1 + Math.max(0, burialNorm) * 0.5) *
        (1 + backlog * 0.35);
      return [{ kind: 'bury', u, target: T(c.x, c.y), corpse: c, dur: 3 }];
    },
    run(a, ctx, act) {
      if (!ctx.world.corpses.includes(act.corpse)) return 'abort';
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';
      ctx.sim.bury(a, act.corpse);
      return 'done';
    },
  },

  ritual: {
    category: 'ritual',
    propose(a, ctx) {
      const shrines = ctx.world
        .structuresOfKind('shrine')
        .concat(ctx.world.sites?.filter((s) => s.kind === 'graves') || []);
      if (!shrines.length) return [];
      const s = topN(shrines, 1, (x) => -dist(a, x))[0];
      const u =
        ((a.affect.e.grief * 1.4 +
          a.affect.e.awe * 1.2 +
          a.genome.expressive * 0.5 +
          (ctx.sim.ritualPull || 0)) *
          0.9) /
        (1 + dist(a, s) * 0.04);
      if (u < 0.4) return [];
      return [{ kind: 'ritual', u, target: T(s.x, s.y), site: s, dur: 3 }];
    },
    run(a, ctx, act) {
      if (dist(a, act.target) > 1.2) {
        stepToward(a, ctx.world, act.target);
        return 'continue';
      }
      if (--act.dur > 0) return 'continue';
      ctx.sim.performRitual(a, act.site);
      return 'done';
    },
  },

  makeArt: {
    category: 'thought',
    propose(a, ctx) {
      if (a.body.hunger > 0.55) return [];
      const medium = a.bestToolFor('art', ctx.ont) || a.bestToolFor('record', ctx.ont);
      const u =
        (a.genome.expressive * 1.3 +
          a.affect.e.awe +
          a.affect.e.grief * 0.8 +
          a.affect.e.love * 0.6) *
          (ctx.bias?.create ?? 1) *
          (medium ? 1.4 : 0.6) -
        a.body.hunger;
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
      if (a.body.hunger > 0.65) return [];
      const u =
        (0.4 + a.genome.curiosity * 1.3) *
        (ctx.bias?.explore ?? 1) *
        (1 - a.body.hunger * 0.6) *
        Math.max(0.35, a.body.energy);

      const spans =
        ctx.world.bridgeSpanCount?.(a.x, a.y, 30) ??
        ctx.world.structuresOfKind('bridge').length;
      const far = ctx.sim.farBankTarget?.(a, 22);

      if (far && spans > 0) {
        return [{ kind: 'explore', u: u * 1.45, target: T(far.x, far.y), dur: 24 }];
      }

      const r = 12 + Math.round(a.genome.curiosity * 30);
      let target = null;
      for (let i = 0; i < 30 && !target; i++) {
        const t = T(
          clamp(a.x + ctx.rng.int(-r, r), 1, ctx.world.w - 2),
          clamp(a.y + ctx.rng.int(-r, r), 1, ctx.world.h - 2),
        );
        if (!ctx.world.walkable(t.x, t.y)) continue;
        const probe = { x: a.x, y: a.y, stats: { steps: 0 } };
        stepToward(probe, ctx.world, t);
        if (probe.stats.steps > 0) target = t;
      }
      if (!target) return [];
      return [{ kind: 'explore', u, target, dur: 16 }];
    },
    run(a, ctx, act) {
      const arrived = stepToward(a, ctx.world, act.target);
      const bed = ctx.world.bedAt(a.x, a.y);
      if (bed) {
        for (const key of Object.keys(bed)) {
          if (key === 'game') continue;
          const known = a.memory.knows(key, 0.3);
          a.memory.learn(key, {
            kind: 'matter',
            confidence: known ? 0.15 : 0.6,
            valence: 0.3,
            source: 'exploration',
          });
          a.memory.learn(`where:${key}`, {
            kind: 'place',
            confidence: 0.5,
            valence: 0.3,
            payload: { x: a.x, y: a.y },
          });
          if (!known) {
            ctx.sim.record(
              a,
              'discovery',
              `${a.name} found ${ctx.ont.get(key)?.word || key} out past the ${ctx.world.season} ground`,
              { valence: 0.5, intensity: 0.5, concept: key, quiet: true },
            );
            appraise(a, {
              goalCongruence: 0.35,
              agency: 'self',
              intensity: 0.4,
              novelty: 0.8,
              kind: 'discovery',
            });
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
    propose() {
      return [{ kind: 'idle', u: U.idle, dur: 1 }];
    },
    run(a, ctx) {
      a.body.rest = clamp(a.body.rest + 0.02, 0, 1);
      const t = T(
        clamp(a.x + ctx.rng.int(-3, 3), 1, ctx.world.w - 2),
        clamp(a.y + ctx.rng.int(-3, 3), 1, ctx.world.h - 2),
      );
      stepToward(a, ctx.world, t);
      return 'done';
    },
  },
};

export {
  STRUCTURE_KINDS,
  stepToward,
  beside,
  nearWater,
  T,
  normPull,
  normsFor,
  availableMaterial,
  takeMaterial,
  learnStructureUse,
  knownStructureUse,
};
