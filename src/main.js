// The observatory. Everything below is presentation and pacing: the world itself
// lives in src/sim and does not know this file exists.

import { Simulation } from './sim/sim.js';
import { Renderer, OVERLAYS } from './ui/render.js';
import { Panels } from './ui/panels.js';
import { renderReport } from './ui/report.js';
import { LLMBridge } from './llm/bridge.js';

const $ = (s) => document.querySelector(s);

// Speeds are stated as ticks per second — one tick is an hour in the world, so
// 24 ticks/s is a day a second. "Max" runs as fast as one frame can afford.
const SPEEDS = [
  { label: 'hold', tps: 0 },
  { label: '1×', tps: 4 },
  { label: '3×', tps: 12 },
  { label: '8×', tps: 32 },
  { label: '20×', tps: 80 },
  { label: '60×', tps: 240 },
  { label: 'max', tps: Infinity },
];

const state = {
  sim: null,
  speedIdx: 0,
  running: false,
  selected: null,
  lastFrame: 0,
  carry: 0,
  ticksThisSecond: 0,
  tickRate: 0,
  rateStamp: 0,
  lastPanel: 0,
  reportOpen: false,
};

const renderer = new Renderer($('#world'));
const llm = new LLMBridge();
const panels = new Panels(document, { onSelect: select });

// ── world lifecycle ───────────────────────────────────────────────────────
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

// ── the loop ──────────────────────────────────────────────────────────────
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - state.lastFrame) / 1000 || 0);
  state.lastFrame = now;

  const sim = state.sim;
  if (!sim) return;

  if (state.running && !state.reportOpen) {
    const tps = SPEEDS[state.speedIdx].tps;
    let ran = 0;
    if (tps === Infinity) {
      // spend a fixed slice of the frame on simulation, keep the rest for drawing
      const budget = now + 9;
      while (performance.now() < budget && sim.living.length) { sim.step(); ran++; if (ran > 4000) break; }
    } else {
      state.carry += tps * dt;
      const want = Math.min(Math.floor(state.carry), 600);
      state.carry -= want;
      for (let i = 0; i < want; i++) { sim.step(); ran++; }
    }
    state.ticksThisSecond += ran;
    if (ran) {
      panels.pushEvents(sim.drainLog(), sim);
      maybeVoice(sim);
    }
    if (!sim.living.length && state.running) {
      state.running = false;
      updatePlayBtn();
      openReport('Everyone is dead. This is what their world amounted to.');
    }
  }

  if (now - state.rateStamp > 500) {
    state.tickRate = state.ticksThisSecond / ((now - state.rateStamp) / 1000);
    state.ticksThisSecond = 0;
    state.rateStamp = now;
    $('#rateOut').textContent = state.running ? `${Math.round(state.tickRate)} hours/s` : 'paused';
  }

  paint();
  if (now - state.lastPanel > 420) { state.lastPanel = now; refreshPanels(); }
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
}

let lastRoster = 0, lastWorldPane = 0;
function refreshPanels(force = false) {
  const sim = state.sim;
  if (!sim) return;
  const now = performance.now();
  // the roster and world pane are rebuilt wholesale, so they are refreshed
  // rarely: a list that redraws under the cursor is a list you cannot click.
  if (panels.active === 'people' && (force || now - lastRoster > 1200)) { lastRoster = now; panels.renderRoster(sim, state.selected); }
  if (panels.active === 'mind' || force) panels.renderMind(sim, state.selected);
  if (panels.active === 'world' && (force || now - lastWorldPane > 1500)) { lastWorldPane = now; panels.renderWorld(sim); }
}

// ── the optional voice ────────────────────────────────────────────────────
let voiceCooldown = 0;
function maybeVoice(sim) {
  if (!llm.enabled || !llm.ready()) return;
  if (sim.world.tick < voiceCooldown) return;
  voiceCooldown = sim.world.tick + 4;
  // whoever is most stirred up, or whoever the observer is watching
  const pool = state.selected ? [sim.byId(state.selected)].filter(Boolean) : sim.living;
  if (!pool.length) return;
  let who = pool[0];
  for (const a of pool) if (a.affect.arousal > who.affect.arousal) who = a;
  llm.thought(who, sim).then((text) => {
    if (!text || !who.alive) return;
    who.say(text, 'thought');
    sim.record(who, 'thought', text, { actors: [who.id], intensity: 0.25, valence: who.affect.valence * 0.3, voice: who.name });
    $('#llmState').textContent = llm.label;
  });
}

// ── report ────────────────────────────────────────────────────────────────
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

// ── controls ──────────────────────────────────────────────────────────────
function setSpeed(i) {
  state.speedIdx = i;
  state.running = SPEEDS[i].tps > 0;
  state.carry = 0;
  for (const b of $('#speeds').children) b.setAttribute('aria-pressed', String(+b.dataset.i === i));
  updatePlayBtn();
}

function updatePlayBtn() {
  $('#playBtn').textContent = state.running ? '❚❚ Pause' : '▶ Play';
}

function togglePlay() {
  if (state.running) {
    setSpeed(0);
    openReport();
  } else {
    closeReport();
    setSpeed(state.speedIdx > 0 ? state.speedIdx : 1);
  }
}

function showTab(name) {
  panels.active = name;
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of document.querySelectorAll('.pane')) p.dataset.active = String(p.id === `pane-${name}`);
  refreshPanels(true);
}

function buildControls() {
  const speeds = $('#speeds');
  speeds.innerHTML = SPEEDS.map((s, i) => `<button class="speed" data-i="${i}" aria-pressed="${i === 0}" title="${s.tps === Infinity ? 'as fast as this machine allows' : `${s.tps} world-hours per second`}">${s.label}</button>`).join('');
  speeds.addEventListener('click', (e) => {
    const b = e.target.closest('.speed');
    if (b) setSpeed(+b.dataset.i);
  });

  const ov = $('#overlays');
  ov.innerHTML = OVERLAYS.map((o) => `<button class="overlay-btn" data-ov="${o.key}" aria-pressed="${o.key === renderer.overlay}">${o.label}</button>`).join('');
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
  $('#newBtn').addEventListener('click', () => newWorld($('#seedInput').value.trim() || String(Date.now())));
  $('#seedInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#newBtn').click(); });

  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeReport(); });

  // llm dialog
  const dlg = $('#dialog');
  $('#llmBtn').addEventListener('click', () => {
    $('#llmProvider').value = llm.cfg.provider;
    $('#llmBase').value = llm.cfg.base;
    $('#llmModel').value = llm.cfg.model;
    $('#llmKey').value = llm.cfg.key;
    dlg.dataset.open = 'true';
  });
  $('#llmCancel').addEventListener('click', () => { dlg.dataset.open = 'false'; });
  dlg.addEventListener('click', (e) => { if (e.target.id === 'dialog') dlg.dataset.open = 'false'; });
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

  // canvas interaction
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
    if (!hit) { tip.dataset.show = 'false'; return; }
    let text = '';
    if (hit.kind === 'person') {
      const a = hit.agent;
      text = `${a.name} · ${a.goal || 'thinking'}`;
    } else if (hit.kind === 'structure') {
      text = `${hit.structure.word || hit.structure.kind} · ${hit.structure.kind} by ${hit.structure.builtBy}`;
    } else {
      const beds = hit.bed ? Object.entries(hit.bed).filter(([, b]) => b.amount > 0.5)
        .map(([k, b]) => `${state.sim.ont.get(k)?.word || k} ${Math.round(b.amount)}`).join(', ') : '';
      text = `${hit.terrain}${beds ? ' · ' + beds : ''}`;
    }
    tip.textContent = text;
    tip.style.left = `${e.clientX - rect.left}px`;
    tip.style.top = `${e.clientY - rect.top}px`;
    tip.dataset.show = 'true';
  });
  cv.addEventListener('mouseleave', () => { tip.dataset.show = 'false'; });

  window.addEventListener('resize', () => { renderer.resize(state.sim?.world); paint(); });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r') openReport();
    else if (e.key === 'Escape') { closeReport(); $('#dialog').dataset.open = 'false'; }
    else if (/^[0-6]$/.test(e.key)) setSpeed(+e.key);
    else if (e.key === 'o') {
      const i = (OVERLAYS.findIndex((o) => o.key === renderer.overlay) + 1) % OVERLAYS.length;
      $(`.overlay-btn[data-ov="${OVERLAYS[i].key}"]`)?.click();
    }
  });
}

buildControls();
newWorld('aurorae');
requestAnimationFrame(frame);
