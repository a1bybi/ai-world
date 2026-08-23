// A generative language. Each culture invents its own phonology at world birth,
// coins words for every concept it discovers, and the sound system drifts over
// generations — so vocabulary is a real historical record, not a fixed word list.

const ONSET_POOLS = [
  ['t', 'k', 'm', 'n', 's', 'l', 'r', 'v', 'h', 'th', 'sh', 'br', 'dr'],
  ['p', 'b', 'd', 'g', 'z', 'f', 'w', 'y', 'kh', 'ng', 'tl', 'gr', 'sk'],
  ['m', 'n', 'l', 'r', 's', 'sh', 'ch', 'j', 'v', 'q', 'x', 'zh', 'pr'],
];
const VOWEL_POOLS = [
  ['a', 'e', 'i', 'o', 'u', 'ae', 'ei'],
  ['a', 'o', 'u', 'au', 'oa', 'ei', 'ie'],
  ['e', 'i', 'y', 'u', 'ea', 'ai', 'oi'],
];
const CODA_POOLS = [
  ['n', 'm', 'l', 'r', 's', 'k', 't', ''],
  ['n', 'r', 'th', 'sh', 'v', 'l', '', ''],
  ['s', 'm', 'ng', 'k', 'r', '', '', ''],
];

export class Language {
  constructor(rng) {
    this.rng = rng;
    this.onsets = rng.pick(ONSET_POOLS).slice();
    this.vowels = rng.pick(VOWEL_POOLS).slice();
    this.codas = rng.pick(CODA_POOLS).slice();
    this.words = new Map();      // conceptKey -> word
    this.taken = new Set();
    this.driftLog = [];          // { generation, from, to }
    this.generation = 1;
    this.name = this.coinRaw(2);
  }

  syllable() {
    const r = this.rng;
    return r.pick(this.onsets) + r.pick(this.vowels) + (r.bool(0.42) ? r.pick(this.codas) : '');
  }

  coinRaw(syllables = null) {
    const n = syllables ?? this.rng.weighted([[1, 2], [2, 6], [3, 3]]);
    let w = '';
    for (let i = 0; i < n; i++) w += this.syllable();
    w = w.replace(/(.)\1\1+/g, '$1$1');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  /** Get or coin a word for a concept key. Compound concepts get compound words. */
  word(key, parts = null) {
    if (this.words.has(key)) return this.words.get(key);
    let w;
    if (parts && parts.length >= 2) {
      const a = this.word(parts[0]);
      const b = this.word(parts[1]);
      w = a.slice(0, Math.max(2, Math.ceil(a.length * 0.6))) + b.slice(0, Math.max(2, Math.floor(b.length * 0.7))).toLowerCase();
    } else {
      let tries = 0;
      do { w = this.coinRaw(); tries++; } while (this.taken.has(w.toLowerCase()) && tries < 20);
    }
    w = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    this.taken.add(w.toLowerCase());
    this.words.set(key, w);
    return w;
  }

  personName(rng = this.rng) {
    const n = rng.weighted([[1, 3], [2, 7], [3, 2]]);
    let w = '';
    for (let i = 0; i < n; i++) w += this.syllable();
    w = w.replace(/(.)\1\1+/g, '$1$1');
    let name = w.charAt(0).toUpperCase() + w.slice(1);
    let suffix = 1;
    while (this.taken.has(name.toLowerCase())) { name = name.replace(/\d*$/, '') + (rng.pick(this.vowels)); suffix++; if (suffix > 6) break; }
    this.taken.add(name.toLowerCase());
    return name;
  }

  placeName(rng = this.rng) {
    return this.personName(rng) + rng.pick(['', '', '-' + this.syllable()]);
  }

  /** Sound change: one phoneme shifts across the whole lexicon. Called each generation. */
  drift(rng = this.rng) {
    this.generation++;
    const from = rng.pick(this.onsets.concat(this.vowels));
    const to = rng.pick(this.onsets.concat(this.vowels));
    if (from === to || from.length > 2) return null;
    let changed = 0;
    for (const [k, v] of this.words) {
      if (v.toLowerCase().includes(from)) {
        const nv = v.slice(1).replace(new RegExp(from, 'g'), to);
        this.words.set(k, v[0] + nv);
        changed++;
      }
    }
    if (changed > 2) {
      this.driftLog.push({ generation: this.generation, from, to, changed });
      return { from, to, changed };
    }
    return null;
  }
}
