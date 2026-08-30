// The Chronicle forgets nothing. Every event ever recorded is kept, indexed by
// era and by person, alongside a running time series. When the observer pauses,
// the Chronicle is what writes the report.

import { clamp, gini, mean, topN, dist } from '../core/util.js';

const ERA_NAMES = [
  'the First Waking', 'the Age of Hands', 'the Age of Fire', 'the Long Making',
  'the Age of Grain', 'the Age of Metal', 'the Age of Letters', 'the Turning Age',
  'the Wide Age', 'the Age After',
];

function glossConcept(sim, keyOrConcept) {
  if (!keyOrConcept) return 'something';
  const c = typeof keyOrConcept === 'string' ? sim.ont.get(keyOrConcept) : keyOrConcept;
  if (!c) return String(keyOrConcept);
  const word = c.word || c.key;
  const fn = c.bestFn || c.kind || null;
  const lex = sim.lexicon?.get?.(word)?.gloss;
  if (lex && lex !== word) return `${word} (${lex})`;
  if (fn && fn !== 'concept' && fn !== 'matter') return `${word} (${fn})`;
  return word;
}

function structureTally(sim, settlement, radius = 14) {
  const counts = {};
  for (const s of sim.world.structures || []) {
    if (Math.hypot(s.x - settlement.x, s.y - settlement.y) > radius) continue;
    counts[s.kind] = (counts[s.kind] || 0) + 1;
  }
  return counts;
}

function storeFillNear(sim, settlement, radius = 14) {
  let held = 0;
  let capacity = 0;
  for (const s of sim.world.structuresOfKind('store')) {
    if (Math.hypot(s.x - settlement.x, s.y - settlement.y) > radius) continue;
    if (!s.stock) continue;
    for (const v of s.stock.values()) held += v;
    capacity += 80; // soft nominal capacity for display
  }
  if (!capacity) return null;
  return {
    held: Math.round(held),
    capacity,
    pct: Math.round(clamp(held / capacity) * 100),
  };
}

export class Chronicle {
  constructor(lang) {
    this.lang = lang;
    this.events = [];
    this.series = [];
    this.eras = [{
      index: 0,
      name: `${lang.coinRaw(2)}, ${ERA_NAMES[0]}`,
      startTick: 0,
      capability: 0,
      endTick: null,
    }];
    this.landmarks = [];
    this.lastReportTick = 0;
    this.reportCount = 0;
    this.byAgent = new Map();
    this.causes = new Map();
    this.priceHistory = new Map();
  }

  add(ev) {
    ev.id = this.events.length + 1;
    ev.era = this.eras.length - 1;
    this.events.push(ev);
    for (const id of ev.actors || []) {
      if (!this.byAgent.has(id)) this.byAgent.set(id, []);
      this.byAgent.get(id).push(ev);
    }
    if (ev.landmark) this.landmarks.push(ev);
    return ev;
  }

  forAgent(id) {
    return this.byAgent.get(id) || [];
  }

  get era() {
    return this.eras[this.eras.length - 1];
  }

  maybeAdvanceEra(sim) {
    const cap = sim.ont.capability();
    const cur = this.era;
    const step = 0.11;
    const level = Math.floor(cap / step);
    const longEnough = sim.world.tick - cur.startTick > 24 * 40;
    if (level > cur.index && longEnough && this.eras.length < ERA_NAMES.length) {
      cur.endTick = sim.world.tick;
      const idx = Math.min(this.eras.length, ERA_NAMES.length - 1);
      const era = {
        index: level,
        name: `${this.lang.coinRaw(2)}, ${ERA_NAMES[idx]}`,
        startTick: sim.world.tick,
        capability: cap,
        endTick: null,
        population: sim.living.length,
      };
      this.eras.push(era);
      sim.record(null, 'era', `A new age begins — ${era.name}`, {
        valence: 0.5, intensity: 1, landmark: true,
      });
      return era;
    }
    return null;
  }

  sample(sim) {
    const living = sim.living;
    const s = {
      tick: sim.world.tick,
      day: sim.world.dayNumber,
      pop: living.length,
      births: sim.counters.births,
      deaths: sim.counters.deaths,
      food: sim.totalFood(),
      knowledge: sim.ont.concepts.size,
      inventions: sim.ont.inventions.length,
      capability: +sim.ont.capability().toFixed(4),
      breadth: +sim.ont.breadth().toFixed(3),
      mood: +mean(living, (a) => a.affect.mood).toFixed(3),
      health: +mean(living, (a) => a.body.health).toFixed(3),
      hunger: +mean(living, (a) => a.body.hunger).toFixed(3),
      literacy: +mean(living, (a) => a.memory.semantic.size).toFixed(1),
      structures: sim.world.structures.length,
      gini: +gini(living.map((a) => a.carried())).toFixed(3),
      trades: sim.counters.trades,
      conflicts: sim.counters.conflicts,
      season: sim.world.season,
      era: this.eras.length - 1,
    };
    this.series.push(s);
    if (this.series.length > 4000) this.series = this.series.filter((_, i) => i % 2 === 0);
    return s;
  }

  notePrice(key, price, tick) {
    if (!this.priceHistory.has(key)) this.priceHistory.set(key, []);
    const arr = this.priceHistory.get(key);
    arr.push({ tick, price: +price.toFixed(3) });
    if (arr.length > 400) arr.shift();
  }

  noteCause(cause) {
    this.causes.set(cause, (this.causes.get(cause) || 0) + 1);
  }

  since(tick) {
    return this.events.filter((e) => e.tick > tick);
  }

  // ── Settlements as places ──────────────────────────────────────────────────

  settlements(sim) {
    const list = sim.settlements?.length
      ? sim.settlements
      : sim.origin
        ? [sim.origin]
        : [];
    return list.map((s) => {
      const people = sim.living.filter(
        (a) => Math.hypot(a.x - s.x, a.y - s.y) < 16,
      );
      const tallies = structureTally(sim, s);
      const store = storeFillNear(sim, s);
      const roles = {};
      for (const a of people) roles[a.role] = (roles[a.role] || 0) + 1;
      const localGoods = new Map();
      for (const a of people) {
        for (const [k, v] of a.inventory) {
          localGoods.set(k, (localGoods.get(k) || 0) + v);
        }
      }
      const topHeld = [...localGoods.entries()]
        .map(([k, v]) => ({ label: glossConcept(sim, k), qty: Math.round(v) }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 6);

      const structureBits = Object.entries(tallies)
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
        .join(', ');

      return {
        name: s.name,
        tier: s.tier || 'camp',
        people: people.length,
        structures: tallies,
        structureLine: structureBits || 'no permanent works yet',
        store,
        roles,
        topHeld,
        mood: people.length
          ? +mean(people, (a) => a.affect.mood).toFixed(2)
          : null,
      };
    });
  }

  // ── Report writing ────────────────────────────────────────────────────────

  report(sim) {
    const now = sim.world.tick;
    const from = this.lastReportTick;
    const window = this.since(from);
    const living = sim.living;
    const dead = sim.dead;
    const first = this.series[0];
    const last = this.series[this.series.length - 1] || {};
    const prevSample = this.series.find((s) => s.tick >= from) || first || {};

    const notable = topN(living.concat(dead), 8, (a) => (
      a.stats.inventions * 4 + a.stats.taught * 2 + a.stats.built * 2 + a.stats.gifts +
      a.stats.trades * 0.6 + a.stats.rescues * 2 + a.children.length * 1.5 + a.titles.length * 3
    ));

    const invNew = sim.ont.inventions.filter(
      (i) => (sim.inventionTicks.get(i.key) ?? 0) > from,
    );
    const summary = this.narrate(sim, window, prevSample, last);

    const r = {
      generatedAt: now,
      windowFrom: from,
      windowTo: now,
      reportNumber: ++this.reportCount,
      time: sim.world.timeString(),
      year: sim.world.year,
      era: this.era,
      eras: this.eras,
      summary,
      totals: {
        population: living.length,
        everLived: sim.agents.length,
        births: sim.counters.births,
        deaths: sim.counters.deaths,
        concepts: sim.ont.concepts.size,
        inventions: sim.ont.inventions.length,
        deadEnds: sim.ont.deadEnds,
        attempts: sim.ont.attempts,
        structures: sim.world.structures.length,
        trades: sim.counters.trades,
        conflicts: sim.counters.conflicts,
        thefts: sim.counters.thefts,
        gifts: sim.counters.gifts,
        rituals: sim.counters.rituals,
        artworks: sim.counters.artworks,
        lessons: sim.counters.lessons,
        words: sim.lang.words.size,
        laws: sim.norms.filter((n) => n.strength > 0.5).length,
      },
      deltas: {
        pop: living.length - (prevSample.pop ?? living.length),
        capability: +((last.capability ?? 0) - (prevSample.capability ?? 0)).toFixed(4),
        knowledge: (last.knowledge ?? 0) - (prevSample.knowledge ?? 0),
        mood: +((last.mood ?? 0) - (prevSample.mood ?? 0)).toFixed(3),
        events: window.length,
      },
      demography: this.demography(sim),
      economy: this.economy(sim),
      places: this.settlements(sim),
      knowledge: {
        capability: +sim.ont.capability().toFixed(3),
        breadth: +sim.ont.breadth().toFixed(3),
        bestFor: [...sim.ont.bestFor.entries()]
          .map(([fn, v]) => ({
            fn,
            label: glossConcept(sim, v.key),
            word: sim.ont.get(v.key)?.word || v.key,
            score: +v.score.toFixed(2),
          }))
          .sort((a, b) => b.score - a.score),
        newInventions: invNew.slice(-24).reverse().map((i) => ({
          key: i.key,
          label: glossConcept(sim, i.key),
          word: i.word || sim.ont.get(i.key)?.word || i.key,
          function: sim.ont.get(i.key)?.bestFn || null,
          advance: !!i.advance,
          maker: i.maker || null,
        })),
        lostKnowledge: sim.lostKnowledge.slice(-12).map((L) => ({
          ...L,
          label: glossConcept(sim, L.key),
        })),
        processes: [...sim.ont.processesKnown],
      },
      culture: {
        language: sim.lang.name,
        drift: sim.lang.driftLog.slice(-6),
        norms: sim.norms.map((n) => ({ ...n })),
        rituals: sim.rituals.slice(-8),
        artworks: sim.artworks.slice(-8),
        beliefs: sim.beliefs.slice(-8),
      },
      society: {
        households: sim.households.length,
        leaders: sim.leaders().map((a) => ({
          name: a.name,
          respect: +sim.respectFor(a).toFixed(2),
          role: a.role,
        })),
        roles: this.roleCensus(living),
        strongestBonds: this.bonds(sim),
      },
      notable: notable.map((a) => this.life(sim, a)),
      deaths: dead.slice(-14).reverse().map((a) => {
        const t = a.deathTick ?? a.diedTick ?? sim.world.tick;
        const age = Math.max(0, a.ageAt(t));
        return {
          name: a.name,
          cause: a.deathCause,
          age: +age.toFixed(1),
          day: Math.floor(t / 24) + 1,
          buried: !!a.buried,
          mourners: a.mourners || 0,
          legacy: a.stats.inventions + a.stats.taught,
          children: a.children.length,
        };
      }),
      causes: [...this.causes.entries()].sort((a, b) => b[1] - a[1]),
      landmarks: this.landmarks.slice(-30).reverse().map((e) => ({
        ...e,
        display: e.plain || e.glossed || e.text,
      })),
      recent: window.slice(-140).reverse().map((e) => ({
        ...e,
        display: e.plain || e.glossed || e.text,
      })),
      series: this.series,
    };
    this.lastReportTick = now;
    return r;
  }

  demography(sim) {
    const living = sim.living;
    const buckets = [0, 0, 0, 0, 0];
    for (const a of living) {
      const age = a.ageAt(sim.world.tick);
      buckets[age < 13 ? 0 : age < 25 ? 1 : age < 40 ? 2 : age < 55 ? 3 : 4]++;
    }
    return {
      ageBuckets: {
        child: buckets[0],
        young: buckets[1],
        adult: buckets[2],
        mature: buckets[3],
        elder: buckets[4],
      },
      meanAge: +mean(living, (a) => a.ageAt(sim.world.tick)).toFixed(1),
      meanLifespan: sim.dead.length
        ? +mean(sim.dead, (a) => Math.max(0, a.ageAt(a.deathTick ?? a.diedTick ?? 0))).toFixed(1)
        : null,
      pairs: living.filter((a) => a.partner).length / 2,
      pregnant: living.filter((a) => a.body.pregnant).length,
      orphans: living.filter(
        (a) =>
          (a.parents?.length || a.motherId || a.fatherId) &&
          [a.motherId, a.fatherId]
            .filter(Boolean)
            .every((p) => !sim.byId(p)?.alive),
      ).length,
      generations: sim.generation,
    };
  }

  economy(sim) {
    const goods = new Map();
    for (const a of sim.living) {
      for (const [k, v] of a.inventory) goods.set(k, (goods.get(k) || 0) + v);
    }
    const prices = [...sim.marketPrices.entries()]
      .map(([k, v]) => ({
        key: k,
        label: glossConcept(sim, k),
        word: sim.ont.get(k)?.word || k,
        price: +v.price.toFixed(2),
        volume: v.volume ?? v.n ?? 0,
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 14);

    return {
      inequality: +gini(sim.living.map((a) => a.carried())).toFixed(3),
      totalGoods: [...goods.values()].reduce((a, b) => a + b, 0),
      topGoods: [...goods.entries()]
        .map(([k, v]) => ({
          label: glossConcept(sim, k),
          word: sim.ont.get(k)?.word || k,
          qty: Math.round(v),
        }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 12),
      prices,
      stores: sim.world.structuresOfKind('store').map((s) => ({
        word: s.word,
        stock: Math.round([...s.stock.values()].reduce((a, b) => a + b, 0)),
      })),
      specialists: this.roleCensus(sim.living),
    };
  }

  roleCensus(living) {
    const m = new Map();
    for (const a of living) m.set(a.role, (m.get(a.role) || 0) + 1);
    return [...m.entries()]
      .map(([role, n]) => ({ role, n }))
      .sort((a, b) => b.n - a.n);
  }

  bonds(sim) {
    const out = [];
    for (const a of sim.living) {
      for (const r of a.relationships.values()) {
        const o = sim.byId(r.id);
        if (!o || !o.alive || o.id < a.id) continue;
        const strength = r.affection + r.trust + r.familiarity;
        if (strength > 1.1) {
          out.push({
            a: a.name,
            b: o.name,
            affection: +r.affection.toFixed(2),
            trust: +r.trust.toFixed(2),
            kin: r.kin > 0.4,
            exchanges: r.exchanges,
            conflicts: r.conflicts,
          });
        }
      }
    }
    return topN(out, 8, (x) => x.affection + x.trust);
  }

  life(sim, a) {
    const evs = this.forAgent(a.id);
    return {
      id: a.id,
      name: a.name,
      alive: a.alive,
      age: +a.ageAt(a.alive ? sim.world.tick : (a.deathTick ?? a.diedTick)).toFixed(1),
      role: a.role,
      titles: a.titles,
      traits: a.traits,
      mood: +a.affect.mood.toFixed(2),
      stats: a.stats,
      children: a.children.length,
      partner: a.partner ? sim.byId(a.partner)?.name : null,
      knows: a.memory.semantic.size,
      remembers: a.memory.stats(),
      cause: a.deathCause,
      milestones: evs
        .filter(
          (e) =>
            e.landmark ||
            e.kind === 'invention' ||
            e.kind === 'bond' ||
            e.kind === 'death',
        )
        .slice(-6)
        .map((e) => ({
          day: Math.floor(e.tick / 24) + 1,
          text: e.plain || e.glossed || e.text,
        })),
    };
  }

  /** Plain-language history written from the numbers. */
  narrate(sim, window, prev, last) {
    const lines = [];
    const pop = sim.living.length;
    const dPop = pop - (prev.pop ?? pop);
    const days = Math.max(1, Math.round((sim.world.tick - this.lastReportTick) / 24));

    lines.push(
      `${sim.lang.name} stands at ${pop} living ${pop === 1 ? 'soul' : 'souls'} on day ${sim.world.dayNumber} of year ${sim.world.year}, in ${this.era.name}.`,
    );

    if (this.reportCount > 1) {
      lines.push(
        `Across the last ${days} day${days === 1 ? '' : 's'} the population ${
          dPop > 0 ? `grew by ${dPop}` : dPop < 0 ? `fell by ${-dPop}` : 'held steady'
        }, with ${window.filter((e) => e.kind === 'birth').length} born and ${
          window.filter((e) => e.kind === 'death').length
        } lost.`,
      );
    }

    // Places
    const places = this.settlements(sim);
    for (const p of places) {
      const storeBit = p.store
        ? `store about ${p.store.pct}% full (${p.store.held} measures)`
        : 'no common store nearby';
      lines.push(
        `${p.name} (${p.tier}): ${p.people} living close by · ${p.structureLine} · ${storeBit}.`,
      );
      if (p.topHeld.length) {
        lines.push(
          `  Most held there: ${p.topHeld.map((g) => `${g.label} ×${g.qty}`).join(', ')}.`,
        );
      }
    }

    const invs = window.filter((e) => e.kind === 'invention');
    if (invs.length) {
      const adv = invs.filter((e) => e.advance);
      lines.push(
        `They tried ${sim.ont.attempts} things in all and kept ${sim.ont.concepts.size}; ${invs.length} new ${
          invs.length === 1 ? 'object' : 'objects'
        } appeared this stretch${
          adv.length
            ? `, of which ${adv.length} bettered anything they had before`
            : ', though none improved on what they already owned'
        }.`,
      );
      // Name a few with function
      const named = invs.slice(-5).map((e) => {
        const label = e.concept ? glossConcept(sim, e.concept) : (e.text || '').slice(0, 40);
        return label;
      });
      if (named.length) {
        lines.push(`Among them: ${named.join('; ')}.`);
      }
    } else if (this.reportCount > 1) {
      lines.push('No new making came of this stretch; the workshops repeated what they already knew.');
    }

    const hunger = last.hunger ?? 0;
    if (hunger > 0.6) {
      lines.push(
        `Hunger is the ruling fact — the average belly sits at ${Math.round(hunger * 100)}% empty and the stores are thin.`,
      );
    } else if (hunger < 0.3) {
      lines.push('Food is not a worry at present; the fields and beds are keeping pace.');
    }

    const mood = last.mood ?? 0;
    lines.push(
      `The common mood is ${
        mood > 0.25 ? 'good' : mood > 0 ? 'level' : mood > -0.25 ? 'strained' : 'grim'
      } (${mood.toFixed(2)}), and inequality of goods sits at ${(last.gini ?? 0).toFixed(2)}.`,
    );

    const conflicts = window.filter((e) => e.kind === 'violence' || e.kind === 'theft').length;
    const kindness = window.filter((e) => e.kind === 'gift' || e.kind === 'rescue').length;
    if (conflicts || kindness) {
      lines.push(
        `There were ${kindness} acts of open kindness and ${conflicts} of harm; the people are ${
          kindness >= conflicts ? 'still holding together' : 'beginning to turn on each other'
        }.`,
      );
    }

    const laws = sim.norms.filter((n) => n.strength > 0.5);
    if (laws.length) {
      lines.push(
        `They now hold ${laws.length} shared rule${laws.length === 1 ? '' : 's'}: ${laws
          .map((n) => n.label)
          .join('; ')}.`,
      );
    }

    const lost = sim.lostKnowledge.filter((l) => l.tick > this.lastReportTick);
    if (lost.length) {
      lines.push(
        `${lost.length} thing${lost.length === 1 ? ' was' : 's were'} forgotten when the only person who knew died: ${lost
          .slice(0, 8)
          .map((l) => glossConcept(sim, l.key))
          .join(', ')}${
          lost.length > 8 ? `, and ${lost.length - 8} more no one can name` : ''
        }.`,
      );
    }

    return lines;
  }
}
