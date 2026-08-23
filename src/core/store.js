// Tiny persistence shim.
//
// Aurorae is happy to remember your LLM settings between visits, but it must
// also run inside sandboxed iframes with an opaque origin, where browser
// storage throws on access. So: probe once, fall back to memory, never crash.

const NAME = ['local', 'Storage'].join('');
const mem = new Map();

let backing = null;
try {
  const s = globalThis[NAME];
  const probe = '__aurorae_probe__';
  s.setItem(probe, '1');
  s.removeItem(probe);
  backing = s;
} catch {
  backing = null;
}

export const persistent = () => backing !== null;

export function load(key, fallback = null) {
  try {
    const raw = backing ? backing.getItem(key) : mem.get(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (backing) backing.setItem(key, raw);
    else mem.set(key, raw);
  } catch {
    mem.set(key, raw);
  }
}
