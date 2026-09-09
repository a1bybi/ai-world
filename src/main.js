// The observatory. Everything below is presentation and pacing: the world itself
// lives in src/sim and does not know this file exists.

import { Simulation } from './sim/sim.js';
import { Renderer, OVERLAYS } from './ui/render.js';
import { Panels } from './ui/panels.js';
import { renderReport } from './ui/report.js';
import { LLMBridge } from './llm/bridge.js';

const $ = (s) => document.querySelector(s);

// One tick = one world-hour.
// Labels are exact multipliers of 1 hour/s (except max = machine budget).
// 24x ≈ one day per second.
const SPEEDS = [
  { label: 'hold', tps: 0 },
  { label: '1x',   tps: 1 },
  { label: '3x',   tps: 3 },
  { label: '8x',   tps: 8 },
  { label: '24x',  tps: 24 },
  { label: '60x',  tps: 60 },
  { label: 'max',  tps: Infinity },
];

const state = {
  sim: null,
  speedIdx: 0,
  lastSpeedIdx: 1,
  running: false,
  selected: null,
  lastFrame: 0,
  carry: 0,
  ticksThisSecond: 0,
  tickRate: 0,
  rateStamp: 0,
  lastPanel: 0,
  lastPaint: 0,
  lastLogPush: 0,
  reportOpen: false,
};

const renderer = new Renderer($('#world'));
const llm = new LLMBridge();
const panels = new Panels(document, { onSelect: select });

function newWorld(seed) {
  state.sim = new Simulation(seed, { population: 14 });
  state.selected = null;
  renderer.selected = null;
  renderer.cacheKey = '';
  panels.clearFeed();
  renderer.resize(state.sim.world);
  $('#worldName').textContent = `${state.sim.settlementName} · ${state.sim.lang.name}`;
  document.title = `${state.sim.settlementName} — Aurorae`;
  panels.pushEvents(state.sim.drainLog(), state.sim);
  paint();
  refreshPanels(true);
  setSpeed(1);
}

function select(id) {
  state.selected = id;
  renderer.selected = id;
  panels.renderMind(state.sim, id);
  showTab('mind');
  panels.renderRoster(state.sim, id);
}

function frame(now) {
  requestAnimationFrame(frame);
  // Cap dt so a background tab does not dump thousands of ticks at once
  const dt = Math.min(0.05, Math.max(0, (now - state.lastFrame) / 1000 || 0));
  state.lastFrame = now;

  const sim = state.sim;
  if (!sim) return;

  const speed = SPEEDS[state.speedIdx];
  const tps = speed.tps;
  const fast = tps === Infinity || tps >= 24;

  if (state.running && !state.reportOpen) {
    let ran = 0;
    if (tps === Infinity) {
      // Spend most of the frame on simulation; leave a little for paint/UI
      const t0 = performance.now();
      const budgetMs = 14;
      while (performance.now() - t0 < budgetMs && sim.living.length) {
        sim.step();
        ran++;
        if (ran >= 6000) break;
      }
    } else if (tps > 0) {
      state.carry += tps * dt;
      // At high multipliers, allow larger bursts so 60x can keep up
      const burstCap = tps >= 60 ? 1200 : tps >= 24 ? 400 : tps >= 8 ? 120 : 40;
      const want = Math.min(Math.floor(state.carry), burstCap);
      state.carry -= want;
      for (let i = 0; i < want; i++) {
        sim.step();
        ran++;
        if (!sim.living.length) break;
      }
    }
    state.ticksThisSecond += ran;

    // Drain log less often when racing - DOM is the usual bottleneck
    const logInterval = fast ? 180 : 50;
    if (ran && now - state.lastLogPush >= logInterval) {
      state.lastLogPush = now;
      panels.pushEvents(sim.drainLog(), sim);
      maybeVoice(sim);
    } else if (!ran && now - state.lastLogPush >= 400) {
      // still flush quiet backlog occasionally
      const buf = sim.drainLog();
      if (buf.length) {
        state.lastLogPush = now;
        panels.pushEvents(buf, sim);
      }
    }

    if (!sim.living.length && state.running) {
      state.running = false;
      updatePlayBtn();
      panels.pushEvents(sim.drainLog(), sim);
      openReport('Everyone is dead. This is what their world amounted to.');
    }
  }

  if (now - state.rateStamp > 400) {
    const elapsed = (now - state.rateStamp) / 1000;
    state.tickRate = elapsed > 0 ? state.ticksThisSecond / elapsed : 0;
    state.ticksThisSecond = 0;
    state.rateStamp = now;
    const el = $('#rateOut');
    if (el) {
      if (!state.running) {
        el.textContent = 'paused';
      } else if (tps === Infinity) {
        el.textContent = `${Math.round(state.tickRate)} hours/s - max`;
      } else {
        el.textContent = `${Math.round(state.tickRate)} hours/s - target ${tps}`;
      }
    }
  }

  // Throttle canvas: full rate when watching closely, slower when accelerating
  const paintEvery = tps === 0 ? 200 : tps === Infinity ? 100 : tps >= 24 ? 80 : tps >= 8 ? 50 : 33;
  if (now - state.lastPaint >= paintEvery) {
    state.lastPaint = now;
    paint();
  }

  const panelEvery = fast ? 700 : 420;
  if (now - state.lastPanel > panelEvery) {
    state.lastPanel = now;
    refreshPanels();
  }
}

function paint() {
  const sim = state.sim;
  if (!sim) return;
  renderer.draw(sim);
  const w = sim.world;
  $('#clock').textContent = w.timeString();
  const era = sim.chronicle.eras[sim.chronicle.eras.length - 1];
  $('#eraChip').textContent = era ? era.name : '—';
  const sc = $('#seasonChip');
  sc.textContent = `${w.season}${w.isNight ? ' · night' : ''}`;
  sc.className = `chip season-${w.season}`;
  $('#weatherChip').textContent = w.weather;

  const chip = $('#statusChip');
  if (chip) {
    const living = sim.living;
    const tick = w.tick;
    const adults = living.filter((a) => !(a.isChild && a.isChild(tick))).length;
    const fd = typeof sim.foodDaysAt === 'function' ? sim.foodDaysAt() : null;
    chip.textContent = [
      `${living.length} living`,
      `${adults} adults`,
      fd != null ? `food ~${fd.toFixed(1)}d` : null,
      sim.archive?.size ? `archive ${sim.archive.size}` : null,
    ].filter(Boolean).join(' · ');
  }
}

let lastRoster = 0;
let lastWorldPane = 0;
function refreshPanels(force = false) {
  const sim = state.sim;
  if (!sim) return;
  const now = performance.now();
  if (panels.active === 'people' && (force || now - lastRoster > 1200)) {
    lastRoster = now;
    panels.renderRoster(sim, state.selected);
  }
  if (panels.active === 'mind' || force) panels.renderMind(sim, state.selected);
  if (panels.active === 'world' && (force || now - lastWorldPane > 1500)) {
    lastWorldPane = now;
    panels.renderWorld(sim);
  }
}

let voiceCooldown = 0;
function maybeVoice(sim) {
  if (!llm.enabled || !llm.ready()) return;
  if (sim.world.tick < voiceCooldown) return;
  voiceCooldown = sim.world.tick + 4;
  const pool = state.selected
    ? [sim.byId(state.selected)].filter(Boolean)
    : sim.living;
  if (!pool.length) return;
  let who = pool[0];
  for (const a of pool) if (a.affect.arousal > who.affect.arousal) who = a;
  llm.thought(who, sim).then((text) => {
    if (!text || !who.alive) return;
    who.say(text, 'thought');
    sim.record(who, 'thought', text, {
      actors: [who.id],
      intensity: 0.25,
      valence: who.affect.valence * 0.3,
      voice: who.name,
    });
    $('#llmState').textContent = llm.label;
  });
}

function openReport(prefaceNote) {
  const sim = state.sim;
  if (!sim) return;
  state.reportOpen = true;
  state.running = false;
  updatePlayBtn();
  const r = sim.report();
  if (prefaceNote) r.summary = [prefaceNote, ...r.summary];
  renderReport($('#sheetInner'), r, sim);
  $('#sheet').dataset.open = 'true';
  $('#sheetInner').scrollTop = 0;
  $('#sheetClose').addEventListener('click', closeReport);
}

function closeReport() {
  state.reportOpen = false;
  $('#sheet').dataset.open = 'false';
}

function setSpeed(i) {
  i = Math.max(0, Math.min(SPEEDS.length - 1, i | 0));
  state.speedIdx = i;
  if (SPEEDS[i].tps > 0) state.lastSpeedIdx = i;
  state.running = SPEEDS[i].tps > 0;
  state.carry = 0;
  state.ticksThisSecond = 0;
  state.rateStamp = performance.now();
  const speeds = $('#speeds');
  if (speeds) {
    for (const b of speeds.children) {
      b.setAttribute('aria-pressed', String(+b.dataset.i === i));
    }
  }
  updatePlayBtn();
}

function updatePlayBtn() {
  $('#playBtn').textContent = state.running ? 'Pause' : 'Play';
}

function togglePlay() {
  if (state.running) {
    setSpeed(0);
  } else {
    closeReport();
    const resume = state.lastSpeedIdx > 0 ? state.lastSpeedIdx : 1;
    setSpeed(resume);
  }
}

function showTab(name) {
  panels.active = name;
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  }
  for (const p of document.querySelectorAll('.pane')) {
    p.dataset.active = String(p.id === `pane-${name}`);
  }
  refreshPanels(true);
}

function buildControls() {
  const speeds = $('#speeds');
  speeds.innerHTML = SPEEDS.map((s, i) => {
    const title =
      s.tps === Infinity
        ? 'as fast as this machine allows'
        : s.tps === 0
          ? 'paused'
          : `${s.tps} world-hour${s.tps === 1 ? '' : 's'} per second`;
    return `<button class="speed" data-i="${i}" aria-pressed="${i === 0}" title="${title}">${s.label}</button>`;
  }).join('');
  speeds.addEventListener('click', (e) => {
    const b = e.target.closest('.speed');
    if (b) setSpeed(+b.dataset.i);
  });

  const ov = $('#overlays');
  ov.innerHTML = OVERLAYS.map(
    (o) =>
      `<button class="overlay-btn" data-ov="${o.key}" aria-pressed="${o.key === renderer.overlay}">${o.label}</button>`,
  ).join('');
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('.overlay-btn');
    if (!b) return;
    renderer.overlay = b.dataset.ov;
    for (const x of ov.children) x.setAttribute('aria-pressed', String(x === b));
    $('#legend').innerHTML = renderer.legendHtml();
  });
  $('#legend').innerHTML = renderer.legendHtml();

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) showTab(t.dataset.tab);
  });

  $('#playBtn').addEventListener('click', togglePlay);
  $('#reportBtn').addEventListener('click', () => openReport());
  $('#newBtn').addEventListener('click', () =>
    newWorld($('#seedInput').value.trim() || String(Date.now())),
  );
  $('#seedInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#newBtn').click();
  });

  $('#sheet').addEventListener('click', (e) => {
    if (e.target.id === 'sheet') closeReport();
  });

  const dlg = $('#dialog');
  $('#llmBtn').addEventListener('click', () => {
    $('#llmProvider').value = llm.cfg.provider;
    $('#llmBase').value = llm.cfg.base;
    $('#llmModel').value = llm.cfg.model;
    $('#llmKey').value = llm.cfg.key;
    dlg.dataset.open = 'true';
  });
  $('#llmCancel').addEventListener('click', () => {
    dlg.dataset.open = 'false';
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.id === 'dialog') dlg.dataset.open = 'false';
  });
  $('#llmSave').addEventListener('click', () => {
    llm.errors = 0;
    llm.save({
      provider: $('#llmProvider').value,
      base: $('#llmBase').value.trim(),
      model: $('#llmModel').value.trim(),
      key: $('#llmKey').value.trim(),
    });
    $('#llmState').textContent = llm.label;
    dlg.dataset.open = 'false';
  });
  $('#llmState').textContent = llm.label;

  const cv = $('#world');
  const tip = $('#tip');
  cv.addEventListener('click', (e) => {
    const rect = cv.getBoundingClientRect();
    const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top, state.sim);
    if (hit?.kind === 'person') select(hit.agent.id);
  });
  cv.addEventListener('mousemove', (e) => {
    const rect = cv.getBoundingClientRect();
    const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top, state.sim);
    if (!hit) {
      tip.dataset.show = 'false';
      return;
    }
    let text = '';
    if (hit.kind === 'person') {
      const a = hit.agent;
      text = `${a.name} · ${a.goal || 'thinking'}`;
    } else if (hit.kind === 'structure') {
      text = `${hit.structure.word || hit.structure.kind} · ${hit.structure.kind} by ${hit.structure.builtBy}`;
    } else {
      const beds = hit.bed
        ? Object.entries(hit.bed)
            .filter(([, b]) => b.amount > 0.5)
            .map(
              ([k, b]) =>
                `${state.sim.ont.get(k)?.word || k} ${Math.round(b.amount)}`,
            )
            .join(', ')
        : '';
      text = `${hit.terrain}${beds ? ' · ' + beds : ''}`;
    }
    tip.textContent = text;
    tip.style.left = `${e.clientX - rect.left}px`;
    tip.style.top = `${e.clientY - rect.top}px`;
    tip.dataset.show = 'true';
  });
  cv.addEventListener('mouseleave', () => {
    tip.dataset.show = 'false';
  });

  window.addEventListener('resize', () => {
    renderer.resize(state.sim?.world);
    paint();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'r') openReport();
    else if (e.key === 'Escape') {
      closeReport();
      $('#dialog').dataset.open = 'false';
    } else if (/^[0-6]$/.test(e.key)) setSpeed(+e.key);
    else if (e.key === 'o') {
      const i =
        (OVERLAYS.findIndex((o) => o.key === renderer.overlay) + 1) %
        OVERLAYS.length;
      $(`.overlay-btn[data-ov="${OVERLAYS[i].key}"]`)?.click();
    }
  });
}

buildControls();
newWorld('aurorae');
requestAnimationFrame(frame);
