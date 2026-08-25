export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);

export function topN(arr, n, score) {
  return arr.slice().sort((a, b) => score(b) - score(a)).slice(0, n);
}

export function softmaxPick(rng, items, score, temperature = 0.35) {
  if (!items.length) return null;
  const scores = items.map(score);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / Math.max(0.01, temperature)));
  const total = exps.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) { r -= exps[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

export function gini(values) {
  const v = values.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return 0;
  const total = v.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return clamp((2 * cum) / (n * total) - (n + 1) / n, 0, 1);
}

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 10000) return Math.round(n / 1000) + 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

export function titleCase(s) {
  return String(s).replace(/(^|[\s-])(\w)/g, (m, a, b) => a + b.toUpperCase());
}

export function pct(n) { return Math.round(clamp(n) * 100) + '%'; }

/** A stable incremental id factory. */
export function idFactory(prefix) {
  let n = 0;
  return () => `${prefix}${++n}`;
}
export function hueFor(i) {
  return `hsl(${(i * 137.5) % 360}, 65%, 55%)`;
}
