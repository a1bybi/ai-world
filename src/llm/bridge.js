// Optional: give the minds a voice.
//
// The simulation does not need this. Every person already perceives, feels,
// weighs every action they could take and picks one — that is all local and
// deterministic from the seed. What an LLM adds is *language*: the inner
// monologue and the dialogue, phrased in their own words, grounded in the state
// the simulation hands over.
//
// It is off by default, bring-your-own-key, and the key never leaves this browser
// except to the provider you name. Requests are throttled and fire-and-forget:
// if the network is slow or the key is wrong, the world carries on unchanged.

const LS = 'aurorae.llm';

export class LLMBridge {
  constructor() {
    this.cfg = { provider: 'off', base: '', model: '', key: '' };
    this.inFlight = 0;
    this.maxInFlight = 2;
    this.lastCall = 0;
    this.minGap = 1400;          // ms between calls, so a fast world does not flood
    this.calls = 0;
    this.errors = 0;
    this.lastError = null;
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(LS);
      if (raw) Object.assign(this.cfg, JSON.parse(raw));
    } catch { /* private browsing, or no storage: run local-only */ }
  }

  save(cfg) {
    Object.assign(this.cfg, cfg);
    try { localStorage.setItem(LS, JSON.stringify(this.cfg)); } catch { /* ignore */ }
  }

  get enabled() { return this.cfg.provider !== 'off' && !!this.cfg.model && (this.cfg.provider === 'ollama' || !!this.cfg.key); }

  get label() {
    if (!this.enabled) return 'minds: local';
    return `minds: ${this.cfg.model}${this.errors ? ` (${this.errors} errors)` : ''}`;
  }

  ready() {
    return this.enabled && this.inFlight < this.maxInFlight && performance.now() - this.lastCall > this.minGap;
  }

  /** Describe a person compactly enough to fit in a prompt but richly enough to be them. */
  static portrait(a, sim) {
    const tick = sim.world.tick;
    const b = a.body;
    const feelings = Object.entries(a.affect.e).filter(([, v]) => v > 0.12)
      .sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
    const rel = [...a.relationships.entries()].slice(0, 4).map(([id, r]) => {
      const o = sim.byId(id);
      return o ? `${o.name}(affection ${r.affection.toFixed(2)}, trust ${r.trust.toFixed(2)}${r.kin ? ', kin' : ''})` : null;
    }).filter(Boolean).join('; ');
    const mems = a.memory.recall(() => true, 4).map((m) => m.text).join(' | ');
    const carrying = [...a.inventory.entries()].filter(([, n]) => n > 0)
      .map(([k, n]) => `${sim.ont.get(k)?.word || k} x${Math.round(n)}`).join(', ');
    return [
      `${a.name}, ${a.ageAt(tick).toFixed(0)} years old, ${a.role}, of ${sim.settlementName}.`,
      `Nature: ${a.traits.join(', ')}.`,
      `Body: hunger ${b.hunger.toFixed(2)}, thirst ${b.thirst.toFixed(2)}, rest ${b.rest.toFixed(2)}, warmth ${b.warmth.toFixed(2)}, health ${b.health.toFixed(2)}.`,
      `Feeling: ${feelings || 'calm'}.`,
      `Intends: ${a.goal || 'nothing in particular'}.`,
      a.reasoning?.length ? `Weighed: ${a.reasoning.map((r) => `${r.kind} (${r.why})`).join('; ')}.` : '',
      carrying ? `Carrying: ${carrying}.` : 'Carrying nothing.',
      rel ? `Knows: ${rel}.` : '',
      mems ? `Remembers: ${mems}.` : '',
      `It is ${sim.world.timeString()}, ${sim.world.season}, ${sim.world.weather}.`,
    ].filter(Boolean).join('\n');
  }

  /** A thought, in their own voice. Resolves to a string, or null if unavailable. */
  async thought(a, sim) {
    const sys = 'You voice the inner monologue of one person in a pre-industrial world that has no names for modern things. '
      + 'Reply with ONE sentence, first person, under 18 words, plain and concrete. No quotation marks, no preamble, no explanation. '
      + 'Never mention numbers, statistics, simulations, or that you are an AI. Speak only of what this person feels, wants, or notices.';
    return this.complete(sys, LLMBridge.portrait(a, sim));
  }

  /** A line of dialogue said to someone, about something. */
  async speech(a, other, topic, sim) {
    const sys = 'You voice one line of speech from a person in a pre-industrial world. '
      + 'Reply with ONE spoken sentence, under 20 words, no quotation marks, no stage directions. '
      + 'It must fit what they feel and what they know. Never mention numbers or modern concepts.';
    const user = `${LLMBridge.portrait(a, sim)}\nThey are speaking to ${other.name}${topic ? ` about ${topic}` : ''}. What do they say?`;
    return this.complete(sys, user);
  }

  async complete(system, user) {
    if (!this.ready()) return null;
    this.inFlight++;
    this.lastCall = performance.now();
    this.calls++;
    try {
      const { provider, base, model, key } = this.cfg;
      let url, headers = { 'content-type': 'application/json' }, body;

      if (provider === 'anthropic') {
        url = (base || 'https://api.anthropic.com') + '/v1/messages';
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        body = { model, max_tokens: 60, system, messages: [{ role: 'user', content: user }] };
      } else if (provider === 'ollama') {
        url = (base || 'http://localhost:11434') + '/v1/chat/completions';
        body = { model, max_tokens: 60, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      } else {
        url = (base || 'https://api.openai.com/v1') + '/chat/completions';
        headers.authorization = `Bearer ${key}`;
        body = { model, max_tokens: 60, temperature: 1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      }

      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
      const data = await res.json();
      const text = provider === 'anthropic'
        ? data.content?.map((c) => c.text).join(' ')
        : data.choices?.[0]?.message?.content;
      return clean(text);
    } catch (e) {
      this.errors++;
      this.lastError = String(e.message || e);
      if (this.errors > 6) this.cfg.provider = 'off';   // stop pestering a broken endpoint
      return null;
    } finally {
      this.inFlight--;
    }
  }
}

function clean(t) {
  if (!t) return null;
  let s = String(t).trim().replace(/^["'“”]+|["'“”]+$/g, '').split('\n')[0].trim();
  if (s.length > 180) s = s.slice(0, 177) + '…';
  return s || null;
}
