// Dynamic Multiverse Code (DMC) — computational branch layer.
//
// This is NOT a claim that the simulation proves physical DMC.
// It formalizes the paper's mechanism inside the agent world:
//   • Probabilistic candidates coexist briefly (branches)
//   • Conscious-like investment reinforces the taken path
//   • Uninvested alternatives decay and are pruned
//
// Toggle with sim.dmcMode (default true). When false, agents behave
// as before — pure softmax without lasting branch memory.
//
// Experimental modes (sim.dmcMode):
//   true / 'full'  — observe + bias + invest + prune
//   false / 'off'  — no branch memory
//   'invest'       — invest + bias, no extra rival decay
//   'prune'        — observe + decay, weak invest

import { clamp } from '../core/util.js';

let _bid = 0;

/**
 * One agent's local multiverse of open possibilities.
 * Weights are relative "investment"; uninvested nodes dissolve.
 */
export class BranchStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=24] Max open branches kept
   * @param {number} [opts.decay=0.12] Per-tick multiplicative decay for non-chosen
   * @param {number} [opts.invest=0.35] Weight added when a branch is chosen
   * @param {number} [opts.pruneBelow=0.04] Drop branches under this weight
   * @param {'full'|'invest'|'prune'|'off'} [opts.mode='full']
   */
  constructor(opts = {}) {
    this.open = new Map(); // key -> { id, kind, key, weight, born, last, payload? }
    this.locked = []; // recently stabilized (high investment) snapshots
    this.pruned = 0;
    this.invested = 0;
    this.capacity = opts.capacity ?? 24;
    this.decay = opts.decay ?? 0.12;
    this.investAmt = opts.invest ?? 0.35;
    this.pruneBelow = opts.pruneBelow ?? 0.04;
    this.mode = opts.mode || 'full';
    /** kind -> count of times chosen (for entropy) */
    this.kindHist = new Map();
  }

  static keyOf(cand) {
    if (!cand) return 'idle';
    const st = cand.payload?.structure;
    const pay =
      cand.payload != null && typeof cand.payload !== 'object'
        ? String(cand.payload)
        : st || '';
    const tgt =
      cand.targetId != null
        ? `:${cand.targetId}`
        : cand.target
          ? `:@${cand.target.x},${cand.target.y}`
          : '';
    return `${cand.kind}${pay ? ':' + pay : ''}${tgt}`;
  }

  setMode(mode) {
    this.mode = mode || 'full';
  }

  /**
   * Register this tick's candidate set into the open multiverse.
   * Existing branches for the same key keep cumulative investment.
   */
  observe(candidates, tick) {
    if (this.mode === 'off') return;
    if (!candidates?.length) return;
    const seen = new Set();
    for (const c of candidates) {
      const key = BranchStore.keyOf(c);
      seen.add(key);
      const prev = this.open.get(key);
      const base = Math.max(0.05, Number(c.u) || 0.05);
      if (prev) {
        prev.weight = clamp(prev.weight * 0.85 + base * 0.08, 0.02, 4);
        prev.last = tick;
        prev.u = c.u;
      } else {
        this.open.set(key, {
          id: ++_bid,
          kind: c.kind,
          key,
          weight: clamp(base * 0.15, 0.05, 1.2),
          born: tick,
          last: tick,
          u: c.u,
        });
      }
    }
    // Decay anything not in this frame's candidate list
    if (this.mode === 'full' || this.mode === 'prune') {
      for (const [key, b] of this.open) {
        if (!seen.has(key)) {
          b.weight *= 1 - this.decay * 1.4;
        }
      }
    }
    this._trim(tick);
  }

  /**
   * Reinforce the chosen action (probabilistic investment).
   * @param {object} chosen candidate
   * @param {number} tick
   * @param {object} [intensity] affect / attention proxy
   */
  invest(chosen, tick, intensity = {}) {
    if (this.mode === 'off') return null;
    if (!chosen) return null;
    const key = BranchStore.keyOf(chosen);
    let b = this.open.get(key);
    if (!b) {
      b = {
        id: ++_bid,
        kind: chosen.kind,
        key,
        weight: 0.2,
        born: tick,
        last: tick,
        u: chosen.u,
      };
      this.open.set(key, b);
    }
    const focus =
      0.6 +
      clamp(intensity.arousal ?? 0.2, 0, 1) * 0.5 +
      clamp(Math.abs(intensity.valence ?? 0), 0, 1) * 0.3 +
      clamp(intensity.attention ?? 0, 0, 1) * 0.4;

    if (this.mode === 'full' || this.mode === 'invest') {
      b.weight = clamp(b.weight + this.investAmt * focus, 0.05, 5);
    } else if (this.mode === 'prune') {
      // Weak invest so keys still exist for pruning dynamics
      b.weight = clamp(b.weight + this.investAmt * 0.15 * focus, 0.05, 5);
    }
    b.last = tick;
    b.chosen = (b.chosen || 0) + 1;
    this.invested++;
    this.kindHist.set(chosen.kind, (this.kindHist.get(chosen.kind) || 0) + 1);

    // Decay rivals — unobserved alternatives dissolve
    if (this.mode === 'full' || this.mode === 'prune') {
      for (const [k, o] of this.open) {
        if (k === key) continue;
        o.weight *= 1 - this.decay * focus;
      }
    }

    // Lock when repeatedly reinforced
    if (b.chosen >= 4 && b.weight > 1.2) {
      this.locked.push({
        key: b.key,
        kind: b.kind,
        weight: b.weight,
        tick,
        chosen: b.chosen,
      });
      if (this.locked.length > 12) this.locked.shift();
    }
    this._trim(tick);
    return b;
  }

  /** Bias utilities by open-branch investment (participatory code). */
  biasUtilities(candidates) {
    if (this.mode === 'off' || this.mode === 'prune') return;
    if (!candidates?.length || !this.open.size) return;
    for (const c of candidates) {
      const b = this.open.get(BranchStore.keyOf(c));
      if (!b) continue;
      const m = 1 + clamp(b.weight * 0.18, 0, 0.55);
      c.u = (Number(c.u) || 0) * m;
    }
  }

  _trim(tick) {
    if (this.mode === 'off') return;
    for (const [key, b] of [...this.open]) {
      if (b.weight < this.pruneBelow && tick - b.last > 3) {
        this.open.delete(key);
        this.pruned++;
      }
    }
    if (this.open.size > this.capacity) {
      const ranked = [...this.open.values()].sort((a, b) => a.weight - b.weight);
      const drop = ranked.slice(0, this.open.size - this.capacity);
      for (const b of drop) {
        this.open.delete(b.key);
        this.pruned++;
      }
    }
  }

  /** Shannon entropy of chosen action kinds (bits). Higher = more diverse paths. */
  kindEntropy() {
    let total = 0;
    for (const n of this.kindHist.values()) total += n;
    if (total <= 0) return 0;
    let h = 0;
    for (const n of this.kindHist.values()) {
      const p = n / total;
      if (p > 0) h -= p * Math.log2(p);
    }
    return h;
  }

  /** Snapshot for observer / report. */
  stats() {
    const top = [...this.open.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((b) => ({ key: b.key, w: +b.weight.toFixed(2), n: b.chosen || 0 }));
    return {
      open: this.open.size,
      pruned: this.pruned,
      invested: this.invested,
      locked: this.locked.length,
      entropy: +this.kindEntropy().toFixed(3),
      top,
      mode: this.mode,
    };
  }

  topBranch() {
    let best = null;
    for (const b of this.open.values()) {
      if (!best || b.weight > best.weight) best = b;
    }
    return best;
  }
}

/**
 * Aggregate world-level DMC stats for the chronicle / metrics.
 */
export function worldBranchStats(living) {
  let open = 0;
  let pruned = 0;
  let invested = 0;
  let locked = 0;
  let entropySum = 0;
  let n = 0;
  const kindTot = new Map();
  for (const a of living || []) {
    const s = a.branches?.stats?.();
    if (!s) continue;
    open += s.open;
    pruned += s.pruned;
    invested += s.invested;
    locked += s.locked;
    entropySum += s.entropy || 0;
    n++;
    if (a.branches?.kindHist) {
      for (const [k, v] of a.branches.kindHist) {
        kindTot.set(k, (kindTot.get(k) || 0) + v);
      }
    }
  }
  // Global action-kind entropy across the population
  let total = 0;
  for (const v of kindTot.values()) total += v;
  let globalEntropy = 0;
  if (total > 0) {
    for (const v of kindTot.values()) {
      const p = v / total;
      if (p > 0) globalEntropy -= p * Math.log2(p);
    }
  }
  return {
    open,
    pruned,
    invested,
    locked,
    meanEntropy: n ? +(entropySum / n).toFixed(3) : 0,
    globalEntropy: +globalEntropy.toFixed(3),
    agents: n,
  };
}

/**
 * Normalize sim.dmcMode into a branch store mode string.
 * @param {boolean|string} dmcMode
 */
export function resolveBranchMode(dmcMode) {
  if (dmcMode === false || dmcMode === 'off') return 'off';
  if (dmcMode === 'invest') return 'invest';
  if (dmcMode === 'prune') return 'prune';
  return 'full';
}
