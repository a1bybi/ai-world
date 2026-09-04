// The chronicle report: what happened, and why, from the last time you looked
// until the moment you hit pause. Written on parchment because it is meant to be
// read, not monitored.

import { lineChart, ageBarsHtml } from './charts.js';
import { fmtNum, pct, titleCase } from '../core/util.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const delta = (v, digits = 0) => {
  if (v == null || Number.isNaN(v)) return '';
  const s = v > 0 ? '+' : '';
  return `<span class="num-d ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${s}${v.toFixed(digits)} since last look</span>`;
};

export function renderReport(host, r, sim) {
  const t = r.totals, d = r.deltas;
  const demo = r.demography || {};

  host.innerHTML = `
    <div class="sheet-head">
      <div>
        <div class="sheet-meta">Chronicle · report ${r.reportNumber} · ${esc(r.time)} · year ${r.year}</div>
        <h2 class="sheet-title" id="sheetTitle">${esc(sim.settlementName)}, ${esc(r.era.name)}</h2>
      </div>
      <button class="sheet-close" id="sheetClose" aria-label="Close report">✕</button>
    </div>
    <div class="sheet-body">

      <div class="narr">${r.summary.map((p) => `<p>${esc(p)}</p>`).join('')}</div>

      <div class="sect">
        <h3>Where things stand</h3>
        <div class="numgrid">
          ${num('living', t.population, delta(d.pop))}
          ${num('ever lived', t.everLived, `${t.births} born · ${t.deaths} lost`)}
          ${num('adults / children', `${demo.adults ?? '—'} / ${demo.children ?? '—'}`, demo.dependency != null ? `dep ${demo.dependency}` : '')}
          ${num('things known', t.concepts, delta(d.knowledge))}
          ${num('capability', (r.knowledge.capability * 100).toFixed(0), delta(d.capability * 100, 1))}
          ${num('inventions', t.inventions, `${fmtNum(t.attempts)} attempts, ${fmtNum(t.deadEnds)} dead ends`)}
          ${num('structures', t.structures, `${r.society.households || 0} households`)}
          ${num('words', t.words, esc(r.culture.language))}
          ${num('mood', (r.series.at(-1)?.mood ?? 0).toFixed(2), delta(d.mood, 2))}
          ${t.foodDays != null ? num('food days', t.foodDays, 'near origin') : ''}
          ${t.archive != null ? num('archive', t.archive, 'shared recipes') : ''}
        </div>
      </div>

      <div class="sect">
        <h3>The shape of the record</h3>
        <div class="cols">
          <div class="chartbox"><h5>Population &amp; deaths</h5><canvas data-chart="pop"></canvas></div>
          <div class="chartbox"><h5>Knowledge &amp; capability</h5><canvas data-chart="know"></canvas></div>
          <div class="chartbox"><h5>Food and hunger</h5><canvas data-chart="food"></canvas></div>
          <div class="chartbox"><h5>Mood, health, inequality</h5><canvas data-chart="mood"></canvas></div>
        </div>
      </div>

      <div class="sect">
        <h3>The people</h3>
        <div class="cols">
          <div>
            <h5 class="sheet-meta">Ages</h5>
            ${ageBarsHtml(demo.ageBuckets)}
            <dl class="kv" style="margin-top:var(--s-3)">
              <dt>adults / children</dt>
              <dd>${demo.adults ?? '—'} / ${demo.children ?? '—'}${demo.dependency != null ? ` · dep ${demo.dependency}` : ''}</dd>
              <dt>mean age</dt><dd>${(demo.meanAge ?? 0).toFixed(1)} years</dd>
              <dt>lifespan</dt><dd>${demo.meanLifespan ? demo.meanLifespan.toFixed(1) + ' years, of those who died' : 'no one has died yet'}</dd>
              <dt>pairs</dt><dd>${demo.pairs} bonded${demo.pregnant ? `, ${demo.pregnant} expecting` : ''}</dd>
              <dt>orphans</dt><dd>${demo.orphans}</dd>
              <dt>generations</dt><dd>${demo.generations}</dd>
            </dl>
          </div>
          <div>
            <h5 class="sheet-meta">Who does what</h5>
            <div class="rows">${r.society.roles.map((x) => row(titleCase(x.role), x.n)).join('')}</div>
            <h5 class="sheet-meta" style="margin-top:var(--s-4)">Most respected</h5>
            <div class="rows">${r.society.leaders.map((l) => row(`${esc(l.name)} — ${esc(l.role)}`, pct(l.respect))).join('') || '<div class="row2"><span>No one has authority.</span><span></span></div>'}</div>
          </div>
          <div>
            <h5 class="sheet-meta">Closest bonds</h5>
            <div class="rows">${r.society.strongestBonds.slice(0, 8).map((b) =>
              row(`${esc(b.a)} &amp; ${esc(b.b)}${b.kin ? ' (kin)' : ''}`, `${pct(b.affection)} · ${b.exchanges || 0} exchanges${b.conflicts ? ` · ${b.conflicts} quarrels` : ''}`)).join('') || '—'}</div>
            ${(r.society.householdList || []).length ? `<h5 class="sheet-meta" style="margin-top:var(--s-4)">Households</h5>
            <div class="rows">${r.society.householdList.slice(0, 6).map((h) =>
              row(`${esc((h.names || []).join(', ') || h.id)}`, `${h.size} members`)).join('')}</div>` : ''}
          </div>
        </div>
      </div>

      ${r.deaths.length || r.causes.length ? `<div class="sect">
        <h3>Those who did not make it</h3>
        <div class="cols">
          <div><div class="rows">${r.deaths.slice(0, 12).map((x) =>
            row(`${esc(x.name)}, ${x.age < 1 ? 'an infant' : `${x.age.toFixed(0)} years`} — ${esc(x.cause || 'unknown')}${x.buried ? ', buried' : ', never found'}`, `day ${x.day ?? ''}`)).join('')}</div></div>
          <div>
            <h5 class="sheet-meta">Why they died</h5>
            <div class="rows">${r.causes.map(([c, n]) => row(esc(c), n)).join('')}</div>
            ${r.deaths.some((x) => x.buried) ? '<p style="font-size:var(--text-xs);color:var(--ink-faint)">The dead who were found have been carried to the grave field and named.</p>' : ''}
          </div>
        </div>
      </div>` : ''}

      <div class="sect">
        <h3>What they figured out</h3>
        <div class="cols">
          <div>
            <h5 class="sheet-meta">Best answer to each need</h5>
            <div class="rows">${(r.knowledge.bestFor || []).map((b) =>
              row(`${esc(b.fn)} — <b>${esc(b.word)}</b>`, b.score?.toFixed?.(2) ?? '')).join('')}</div>
          </div>
          <div>
            <h5 class="sheet-meta">Newly made</h5>
            <div class="rows">${(r.knowledge.newInventions || []).slice(0, 10).map((i) =>
              row(
                `${esc(i.word)} — ${esc(i.fn || i.function || i.label || 'thing')}${i.advance ? ' <b>(an advance)</b>' : ''}`,
                `by ${esc(i.by || i.maker || 'someone')}`,
              )).join('') || '<div class="row2"><span>Nothing new was kept.</span><span></span></div>'}</div>
            ${r.knowledge.lostKnowledge?.length ? `<h5 class="sheet-meta" style="margin-top:var(--s-4)">Lost with the dead</h5>
              <div class="rows">${r.knowledge.lostKnowledge.slice(0, 6).map((l) => row(esc(l.word || l.key), `died with ${esc(l.lastKeeper || 'someone')}`)).join('')}</div>` : ''}
          </div>
          <div>
            <h5 class="sheet-meta">Ways of working</h5>
            <div class="rows">${(r.knowledge.processes || []).map((p) => row(esc(typeof p === 'string' ? p : p.key), typeof p === 'string' ? '' : (p.uses ?? ''))).join('')}</div>
          </div>
        </div>
      </div>

      <div class="sect">
        <h3>Trade, holdings and the price of things</h3>
        <div class="cols">
          <div>
            <dl class="kv">
              <dt>trades</dt><dd>${fmtNum(t.trades)} exchanges, ${fmtNum(t.gifts)} civic gifts</dd>
              <dt>thefts</dt><dd>${t.thefts}</dd>
              <dt>inequality</dt><dd>gini ${r.economy.inequality.toFixed(2)}</dd>
              <dt>goods held</dt><dd>${fmtNum(r.economy.totalGoods)}</dd>
              <dt>stored</dt><dd>${Array.isArray(r.economy.stores) ? `${r.economy.stores.length} common stores` : fmtNum(r.economy.stores)}</dd>
            </dl>
          </div>
          <div>
            <h5 class="sheet-meta">What things fetch</h5>
            <div class="rows">${(r.economy.prices || []).slice(0, 8).map((p) => row(esc(p.word || p.key), (p.price ?? 0).toFixed(2))).join('') || '—'}</div>
          </div>
          <div>
            <h5 class="sheet-meta">Most held</h5>
            <div class="rows">${(r.economy.topGoods || []).slice(0, 8).map((g) => row(esc(g.word), fmtNum(g.qty))).join('') || '—'}</div>
          </div>
        </div>
      </div>

      <div class="sect">
        <h3>Custom, law and belief</h3>
        <div class="cols">
          <div>
            <h5 class="sheet-meta">Expectations</h5>
            <div class="rows">${(r.culture.norms || []).map((n) =>
              row(`${esc(n.label)}${n.becameLaw ? ' <b>— now law</b>' : ''}`, `${pct(n.strength)} · ${n.violations} broken`)).join('')}</div>
          </div>
          <div>
            <h5 class="sheet-meta">The tongue drifts</h5>
            <div class="rows">${(r.culture.drift || []).slice(-6).map((x) =>
              row(`generation ${x.generation}: “${esc(x.from)}” became “${esc(x.to)}”`, `${x.changed} words`)).join('') || '<div class="row2"><span>Speech is unchanged since the founding.</span><span></span></div>'}</div>
          </div>
          <div>
            <h5 class="sheet-meta">Rites and things made for their own sake</h5>
            <div class="rows">
              ${row('rituals performed', t.rituals)}
              ${row('artworks', t.artworks)}
              ${row('lessons given', t.lessons)}
              ${(r.culture.beliefs || []).slice(0, 5).map((b) => row(esc(b.text || b.key), `${b.holders ?? 0} hold it`)).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="sect">
        <h3>Lives worth following</h3>
        <div class="cols">
          ${r.notable.slice(0, 6).map((p) => `<div class="card">
            <h4>${esc(p.name)}${p.alive ? '' : ' †'}</h4>
            <div class="card-sub">${p.age.toFixed(0)} years · ${esc(p.role)}${p.titles.length ? ' · ' + p.titles.map(esc).join(', ') : ''}${p.alive ? '' : ` · died of ${esc(p.cause || 'unknown')}`}</div>
            <div style="font-size:var(--text-xs);color:var(--ink-muted)">
              ${esc(p.traits.join(', '))} · knows ${p.knows} things · remembers ${fmtNum(p.remembers.episodes)} moments (${fmtNum(p.remembers.permanent)} forever)
              ${p.partner ? ` · with ${esc(p.partner)}` : ''}${p.children ? ` · ${p.children} children` : ''}
            </div>
            ${p.milestones?.length ? `<ul>${p.milestones.slice(-4).map((m) => `<li><b>d${m.day}</b> ${esc(m.text)}</li>`).join('')}</ul>` : ''}
          </div>`).join('')}
        </div>
      </div>

      <div class="sect">
        <h3>Ages of this world</h3>
        <div class="timeline">
          ${r.eras.map((e) => `<div class="tl-item"><span class="tl-day">day ${Math.floor(e.startTick / 24)}${e.endTick ? `–${Math.floor(e.endTick / 24)}` : ' — present'}</span>
            <b>${esc(e.name)}</b> — capability ${(e.capability * 100).toFixed(0)}, ${e.population} living</div>`).join('')}
        </div>
      </div>

      <div class="sect">
        <h3>Turning points</h3>
        <div class="timeline">
          ${r.landmarks.slice(-24).reverse().map((l) => `<div class="tl-item"><span class="tl-day">day ${l.day}</span>${esc(l.text)}</div>`).join('') || '<p>Nothing yet that anyone will remember.</p>'}
        </div>
      </div>

      <div class="sect">
        <h3>Since you last looked</h3>
        <div class="rows">${meaningful(r.recent).map((e) => row(esc(e.text), `d${e.day}`)).join('') || '<div class="row2"><span>Nothing but the ordinary work of staying alive.</span><span></span></div>'}</div>
      </div>
    </div>`;

  // charts
  const series = r.series;
  const chart = (sel, lines) => {
    const cv = host.querySelector(`canvas[data-chart="${sel}"]`);
    if (cv) requestAnimationFrame(() => lineChart(cv, series, { lines }));
  };
  chart('pop', [{ key: 'pop', color: '#a9751f' }, { key: 'deaths', color: '#a8442f' }, { key: 'births', color: '#4a7d2e' }]);
  chart('know', [{ key: 'knowledge', color: '#6b5aa8' }, { key: 'inventions', color: '#a9751f' }]);
  chart('food', [{ key: 'food', color: '#4a7d2e' }, { key: 'hunger', color: '#a8442f' }]);
  chart('mood', [{ key: 'mood', color: '#2e6f78' }, { key: 'health', color: '#4a7d2e' }, { key: 'gini', color: '#a8442f' }]);
}

// The record keeps everything, but a report that lists every handful of berries
// is not a report. Keep what a person would actually recount.
const DULL = new Set(['gather', 'store', 'takeFromStore', 'sleep', 'drink', 'eat', 'follow', 'idle', 'explore', 'sample', 'craft']);
function meaningful(events) {
  const out = [];
  const seen = new Map();
  for (let i = events.length - 1; i >= 0 && out.length < 34; i--) {
    const e = events[i];
    if (e.landmark) { out.push(e); continue; }
    if (DULL.has(e.kind) || e.quiet) continue;
    const n = (seen.get(e.kind) || 0) + 1;
    seen.set(e.kind, n);
    if (n > 5) continue;                 // no more than five of any one kind
    out.push(e);
  }
  return out;
}

function num(k, v, d = '') {
  return `<div class="num"><div class="num-k">${k}</div><div class="num-v">${typeof v === 'number' ? fmtNum(v) : v}</div>${d}</div>`;
}
function row(a, b) {
  return `<div class="row2"><span>${a}</span><span>${b}</span></div>`;
}
