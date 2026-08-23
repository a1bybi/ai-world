// Deterministic, seedable random. Every run is reproducible from its seed.

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = 'aurorae') {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed));
    if (this.state === 0) this.state = 0x9e3779b9;
  }
  next() {
    // xorshift32
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x / 4294967296;
  }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.float(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  pickMany(arr, n) {
    const copy = arr.slice(); const out = [];
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(this.next() * copy.length), 1)[0]);
    return out;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  // Box–Muller, clamped
  normal(mean = 0, sd = 1) {
    const u = Math.max(1e-9, this.next()), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  weighted(entries) {
    // entries: [[value, weight], ...]
    let total = 0;
    for (const [, w] of entries) total += Math.max(0, w);
    if (total <= 0) return entries.length ? entries[0][0] : null;
    let r = this.next() * total;
    for (const [v, w] of entries) { r -= Math.max(0, w); if (r <= 0) return v; }
    return entries[entries.length - 1][0];
  }
}
