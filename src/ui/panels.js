// The side panels: the running chronicle, the roster of the living, the inside of
// one person's head, and the state of the world. Everything here is read-only —
// the observer watches, and the world does not care that it is being watched.

import { dominantEmotion, moodWord, EMOTIONS } from '../sim/emotion.js';
import { fmtNum, pct, titleCase, topN } from '../core/util.js';
import { sparkline } from './charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BAD = new Set(['death', 'fight', 'theft', 'starve', 'illness', 'injury', 'loss', 'grief', 'famine']);
const GOOD = new Set(['birth', 'bond', 'invention', 'gift', 'teach', 'ritual', 'art', 'harvest', 'build', 'trade', 'law']);

export class Panels {
  constructor(root, { onSelect }) {
    this.root = root;
    this.onSelect = onSelect;
    this.feedEl = root.querySelector('#feed');
    this.rosterEl = root.querySelector('#roster');
    this.mindEl = root.querySelector('#mind');
    this.worldEl = root.querySelector('#worldPane');
    this.events = [];
    this.max = 260;
    this.active = 'feed';

    this.feedEl.addEventListener('click', (e) => {
      const who = e.target.closest('[data-agent]');
      if (who) this.onSelect(who.dataset.agent);
    });
    this.rosterEl.addEventListener('click', (e) => {
      const who = e.target.closest('[data-agent]');
      if (who) this.onSelect(who.dataset.agent);
    });
  }

  // ── chronicle feed ──────────────────────────────────────────────────────
  pushEvents(evs, sim) {
    if (!evs.length) return;
    const frag = document.createDocumentFragment();
    for (const ev of evs) {
      if (ev.kind === 'sample') continue;
      if (ev.text === this.lastText) continue;   // don't repeat yourself
      this.lastText = ev.text;
      const div = document.createElement('div');
      const cls = ['ev'];
      if (ev.landmark) cls.push('mark');
      else if (ev.valence > 0.25 || GOOD.has(ev.kind)) cls.push('good');
      else if (ev.valence < -0.25 || BAD.has(ev.kind)) cls.push('bad');
      if (ev.kind === 'speech') cls.push('speech');
      if (ev.kind === 'thought') cls.push('thought');
      div.className = cls.join(' ');
      const actor = ev.actors?.[0];
      const who = actor ? sim.byId(actor) : null;
      let text = esc(ev.text);
      if (who) text = text.replace(who.name, `<span class="ev-who" data-agent="${who.id}">${esc(who.name)}</span>`);
      const quote = ev.kind === 'speech' || ev.kind === 'thought';
      div.innerHTML = `<span class="ev-day">d${ev.day}</span><span class="ev-text">${quote && who ? `<span class="ev-who" data-agent="${who.id}">${esc(who.name)}</span>: “${esc(ev.text)}”` : text}</span>`;
      frag.appendChild(div);
      this.events.push(ev);
    }
    this.feedEl.prepend(frag);
    while (this.feedEl.children.length > this.max) this.feedEl.lastElementChild.remove();
    this.root.querySelector('#feedCount').textContent = `${fmtNum(this.events.length)} recorded`;
  }

  clearFeed() {
    this.feedEl.innerHTML = '';
    this.events = [];
  }

  // ── roster ──────────────────────────────────────────────────────────────
  renderRoster(sim, selectedId) {
    const tick = sim.world.tick;
    const people = [...sim.living].sort((a, b) => b.ageAt(tick) - a.ageAt(tick));
    this.root.querySelector('#popCount').textContent = `${people.length} alive · ${sim.dead.length} gone`;
    if (!people.length) {
      this.rosterEl.innerHTML = '<div class="empty">No one is left alive. The chronicle remains.</div>';
      return;
    }
    this.rosterEl.innerHTML = people.map((a) => {
      const m = (a.affect.mood + 1) / 2;
      const hue = Math.round(m * 120);
      const age = a.ageAt(tick);
      const stage = a.isChild(tick) ? 'child' : a.isElder(tick) ? 'elder' : titleCase(a.role);
      return `<button class="person" data-agent="${a.id}" data-sel="${a.id === selectedId}">
        <span>
          <span class="person-name">${esc(a.name)}</span>
          <span class="person-sub">${age.toFixed(0)}y · ${esc(stage)} · ${esc(a.goal || 'thinking')}</span>
        </span>
        <span class="person-mood" style="background:hsl(${hue} 62% 52%)" title="${moodWord(a.affect.mood)}"></span>
      </button>`;
    }).join('');
  }

  // ── the mind ────────────────────────────────────────────────────────────
  renderMind(sim, id) {
    if (!id) { this.mindEl.innerHTML = '<div class="empty">Click anyone on the map, or in People, to look inside their head.</div>'; return; }
    const a = sim.byId(id);
    if (!a) { this.mindEl.innerHTML = '<div class="empty">That person is no longer in the world.</div>'; return; }
    const tick = sim.world.tick;
    const b = a.body;
    const age = a.ageAt(tick);
    const emo = dominantEmotion(a);

    const bar = (label, v, color) => `<div class="bar-row"><span class="bar-label">${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:${color}"></span></span>
      <span class="bar-val">${Math.round(v * 100)}</span></div>`;

    const feelings = topN(EMOTIONS.map((k) => ({ k, v: a.affect.e[k] })), 5, (x) => x.v).filter((x) => x.v > 0.04);

    const rels = topN([...a.relationships.entries()].map(([oid, r]) => ({ oid, r })), 6,
      (x) => Math.abs(x.r.affection - 0.3) + x.r.trust * 0.4 + x.r.conflicts * 0.2);

    const inv = [...a.inventory.entries()].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).slice(0, 10);
    const skills = topN(Object.entries(a.skills).map(([k, v]) => ({ k, v })), 6, (x) => x.v).filter((x) => x.v > 0.03);
    const mems = a.memory.recall(() => true, 7).sort((x, y) => y.tick - x.tick);
    const beliefs = [...a.memory.semantic.entries()].slice(-6);

    const lifeStage = !a.alive ? 'dead' : a.isChild(tick) ? 'child' : a.isElder(tick) ? 'elder' : 'adult';
    const kin = a.parents.map((p) => sim.byId(p)?.name).filter(Boolean);

    this.mindEl.innerHTML = `
      <div class="mind-head">
        <div class="mind-name">${esc(a.name)}</div>
        <div class="mind-sub">${a.alive ? `${age.toFixed(1)} years · ${lifeStage} · ${esc(titleCase(a.role))} · feeling ${esc(moodWord(a.affect.mood))}`
          : `died on day ${Math.floor(a.deathTick / 24)} of ${esc(a.deathCause || 'unknown causes')}, aged ${a.ageAt(a.deathTick).toFixed(1)}`}</div>
        <div class="titles">
          ${a.titles.map((t) => `<span class="tag warm">${esc(t)}</span>`).join('')}
          <span class="tag">${esc(emo)}</span>
          ${a.traits.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          ${b.pregnant ? '<span class="tag life">expecting</span>' : ''}
          ${a.partner ? `<span class="tag life">with ${esc(sim.byId(a.partner)?.name || 'someone')}</span>` : ''}
        </div>
      </div>

      ${a.alive ? '' : '<div class="block"><h4>No longer living</h4><div class="reason-why">What follows is the record as it stood when they died. Whatever only they knew went with them.</div></div>'}

      <div class="block">
        <h4>${a.alive ? 'Doing now' : 'Doing at the end'}</h4>
        <div style="font-size:var(--text-lg);margin-bottom:var(--s-2)">${esc(a.goal || 'considering')}</div>
        <div class="reason">
          ${(a.reasoning || []).map((r, i) => `<div class="reason-item">
            <span>${esc(r.kind)}<br><span class="reason-why">${esc(r.why || '')}</span></span>
            <span class="reason-u">${r.u.toFixed(2)}${i === 0 ? ' ✓' : ''}</span>
          </div>`).join('') || '<div class="reason-why">No deliberation recorded yet.</div>'}
        </div>
      </div>

      <div class="block">
        <h4>Body</h4>
        ${bar('health', b.health, 'var(--green)')}
        ${bar('hunger', b.hunger, 'var(--rust)')}
        ${bar('thirst', b.thirst, 'var(--teal)')}
        ${bar('rest', b.rest, 'var(--violet)')}
        ${bar('warmth', b.warmth, 'var(--amber)')}
        ${b.injury > 0.01 ? bar('injury', b.injury, 'var(--rust)') : ''}
        ${b.illness > 0.01 ? bar('illness', b.illness, 'var(--rust)') : ''}
      </div>

      <div class="block">
        <h4>Feeling</h4>
        ${feelings.length ? feelings.map((f) => bar(f.k, f.v, 'var(--amber)')).join('') : '<div class="reason-why">Calm.</div>'}
      </div>

      <div class="block">
        <h4>Knows how</h4>
        ${skills.length ? skills.map((s) => bar(s.k, s.v, 'var(--teal)')).join('') : '<div class="reason-why">Still learning everything.</div>'}
        <dl class="kv" style="margin-top:var(--s-3)">
          <dt>ideas held</dt><dd>${a.memory.semantic.size} things known, ${a.memory.stats().links} connections between them</dd>
          <dt>invented</dt><dd>${a.stats.inventions} ${a.stats.inventions === 1 ? 'thing' : 'things'} · taught others ${a.stats.taught} times</dd>
        </dl>
      </div>

      <div class="block">
        <h4>Carrying</h4>
        ${inv.length ? inv.map(([k, n]) => `<div class="listline"><span>${esc(sim.ont.get(k)?.word || k)}</span><span>${n.toFixed(0)}</span></div>`).join('')
          : '<div class="reason-why">Empty-handed.</div>'}
      </div>

      <div class="block">
        <h4>People</h4>
        ${kin.length ? `<div class="listline"><span>born to</span><span>${esc(kin.join(', '))}</span></div>` : ''}
        ${a.children.length ? `<div class="listline"><span>children</span><span>${a.children.map((c) => esc(sim.byId(c)?.name || '—')).join(', ')}</span></div>` : ''}
        ${rels.map(({ oid, r }) => {
          const o = sim.byId(oid);
          if (!o) return '';
          const feel = r.affection > 0.66 ? 'loves' : r.affection > 0.45 ? 'likes' : r.affection < 0.2 ? 'resents' : 'knows';
          return `<div class="listline"><span><span class="ev-who" data-agent="${oid}">${esc(o.name)}</span> — ${feel}${r.kin ? ', kin' : ''}</span>
            <span>trust ${pct(r.trust)}${r.conflicts ? ` · ${r.conflicts} quarrels` : ''}</span></div>`;
        }).join('')}
      </div>

      <div class="block">
        <h4>Remembers</h4>
        ${mems.map((m) => `<div class="mem"><span class="mem-day">day ${Math.floor(m.tick / 24)}</span> ${esc(m.text)}${m.permanent ? ' <b>·</b>' : ''}</div>`).join('')}
        <div class="mem" style="border:0;color:var(--ink-faint)">${a.memory.stats().permanent} of these will never be forgotten.</div>
      </div>

      ${beliefs.length ? `<div class="block"><h4>Believes</h4>
        ${beliefs.map(([k, v]) => `<div class="listline"><span>${esc(k)}</span><span>${esc(String(v.confidence != null ? pct(v.confidence) : ''))}</span></div>`).join('')}
      </div>` : ''}

      <div class="block">
        <h4>Life so far</h4>
        <dl class="kv">
          <dt>harvested</dt><dd>${fmtNum(a.stats.harvested)}</dd>
          <dt>made</dt><dd>${a.stats.crafted} things, ${a.stats.built} structures</dd>
          <dt>meals</dt><dd>${a.stats.meals}</dd>
          <dt>traded</dt><dd>${a.stats.trades} times, gave ${a.stats.gifts} gifts</dd>
          <dt>quarrels</dt><dd>${a.stats.fights}${a.stats.thefts ? `, ${a.stats.thefts} thefts` : ''}</dd>
          <dt>walked</dt><dd>${fmtNum(a.stats.steps)} steps</dd>
        </dl>
      </div>`;

    this.mindEl.querySelectorAll('[data-agent]').forEach((el) => {
      el.addEventListener('click', () => this.onSelect(el.dataset.agent));
    });
  }

  // ── world pane ──────────────────────────────────────────────────────────
  renderWorld(sim) {
    const w = sim.world;
    const series = sim.chronicle.series;
    const last = series[series.length - 1] || {};
    const ont = sim.ont;

    const stat = (k, v, d) => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}</div>${d ? `<div class="stat-d">${d}</div>` : ''}</div>`;

    const roleCounts = new Map();
    for (const a of sim.living) roleCounts.set(a.role, (roleCounts.get(a.role) || 0) + 1);

    const prices = [...sim.marketPrices.entries()].map(([k, m]) => [k, m.price ?? m, m.volume ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const norms = sim.norms.filter((n) => n.strength > 0.05).sort((a, b) => b.strength - a.strength);
    const best = [...ont.bestFor.entries()].slice(0, 10);

    this.worldEl.innerHTML = `
      <div class="statgrid">
        ${stat('people', sim.living.length, `${sim.counters.births} born · ${sim.counters.deaths} died`)}
        ${stat('knows', ont.concepts.size, `${ont.inventions.length} inventions from ${fmtNum(ont.attempts)} attempts`)}
        ${stat('capability', (ont.capability() * 100).toFixed(0), `breadth ${pct(ont.breadth())}`)}
        ${stat('food', fmtNum(sim.totalFood()), `${w.structures.filter((s) => s.kind === 'store').length} stores`)}
      </div>
      <div class="block"><h4>Population</h4><canvas class="spark" data-series="pop"></canvas></div>
      <div class="block"><h4>Knowledge</h4><canvas class="spark" data-series="knowledge"></canvas></div>
      <div class="block"><h4>Food in hand</h4><canvas class="spark" data-series="food"></canvas></div>
      <div class="block"><h4>Mood of the people</h4><canvas class="spark" data-series="mood"></canvas></div>

      <div class="block">
        <h4>This place</h4>
        <dl class="kv">
          <dt>settlement</dt><dd>${esc(sim.settlementName)}</dd>
          <dt>tongue</dt><dd>${esc(sim.lang.name)} · ${sim.lang.words.size} words</dd>
          <dt>season</dt><dd>${esc(w.season)}, ${esc(w.weather)}, ${(w.temperature * 100).toFixed(0)}% warmth</dd>
          <dt>built</dt><dd>${w.structures.length} structures${w.structures.length ? ` (${[...new Set(w.structures.map((s) => s.kind))].join(', ')})` : ''}</dd>
          <dt>places</dt><dd>${w.sites.map((s) => esc(s.name)).join(', ') || '—'}</dd>
        </dl>
      </div>

      <div class="block">
        <h4>Who does what</h4>
        ${[...roleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `<div class="listline"><span>${esc(titleCase(r))}</span><span>${n}</span></div>`).join('') || '<div class="reason-why">—</div>'}
      </div>

      <div class="block">
        <h4>The best they have</h4>
        ${best.map(([fn, c]) => `<div class="listline"><span>${esc(fn)}</span><span>${esc(c.word)} ${c.bestScore?.toFixed(2) ?? ''}</span></div>`).join('') || '<div class="reason-why">Bare hands.</div>'}
      </div>

      <div class="block">
        <h4>What things are worth</h4>
        ${prices.length ? prices.map(([k, v, vol]) => `<div class="listline"><span>${esc(sim.ont.get(k)?.word || k)}</span><span>${Number(v).toFixed(2)}${vol ? ` · ${vol} traded` : ''}</span></div>`).join('')
          : '<div class="reason-why">Nothing has been traded yet.</div>'}
      </div>

      <div class="block">
        <h4>What is expected of people</h4>
        ${norms.length ? norms.map((n) => `<div class="listline"><span>${esc(n.label)}${n.becameLaw ? ' <span class="tag harm">law</span>' : ''}</span><span>${pct(n.strength)}</span></div>`).join('')
          : '<div class="reason-why">No shared expectations have formed.</div>'}
      </div>

      <div class="block">
        <h4>Now</h4>
        <dl class="kv">
          <dt>hunger</dt><dd>${pct(last.hunger ?? 0)} average</dd>
          <dt>health</dt><dd>${pct(last.health ?? 1)} average</dd>
          <dt>inequality</dt><dd>gini ${(last.gini ?? 0).toFixed(2)}</dd>
          <dt>era</dt><dd>${esc(sim.chronicle.eras[sim.chronicle.eras.length - 1]?.name || '—')}</dd>
        </dl>
      </div>`;

    for (const cv of this.worldEl.querySelectorAll('canvas.spark')) {
      const key = cv.dataset.series;
      sparkline(cv, series.map((s) => s[key] ?? 0), {
        color: key === 'pop' ? '#e0a33c' : key === 'knowledge' ? '#8f7bc4' : key === 'food' ? '#6daa45' : '#3f9c8e',
        zero: key === 'mood' ? 0 : undefined,
      });
    }
  }
}
