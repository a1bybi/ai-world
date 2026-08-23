// Small, dependency-free canvas charts. No library: this has to run from a plain
// static host with no build step, and the shapes we need are simple.

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(60, rect.width || canvas.clientWidth || 200);
  const h = Math.max(24, rect.height || canvas.clientHeight || 60);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function sparkline(canvas, values, { color = '#e0a33c', fill = true, zero } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!values.length) return;
  const pad = 3;
  let min = Math.min(...values), max = Math.max(...values);
  if (zero !== undefined) { min = Math.min(min, zero); max = Math.max(max, zero); }
  if (max - min < 1e-6) { max = min + 1; }
  const X = (i) => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
  const Y = (v) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);

  if (zero !== undefined) {
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(zero)); ctx.lineTo(w - pad, Y(zero)); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (fill) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color.replace(')', ', 0.28)').replace('rgb', 'rgba').replace('#', '#'));
    ctx.fillStyle = hexAlpha(color, 0.22);
    ctx.beginPath();
    ctx.moveTo(X(0), h - pad);
    values.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(values.length - 1), h - pad);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();

  const lastY = Y(values[values.length - 1]);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(X(values.length - 1), lastY, 2, 0, Math.PI * 2); ctx.fill();
}

function hexAlpha(hex, a) {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Multi-series line chart for the chronicle report (light parchment ground). */
export function lineChart(canvas, series, { lines, xKey = 'day', light = true } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!series.length) return;
  const padL = 34, padR = 8, padT = 8, padB = 18;
  const ink = light ? 'rgba(42,35,26,' : 'rgba(242,236,227,';
  const xs = series.map((s) => s[xKey] ?? 0);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (v) => padL + ((v - x0) / Math.max(1e-6, x1 - x0)) * (w - padL - padR);

  let min = Infinity, max = -Infinity;
  for (const L of lines) for (const s of series) {
    const v = s[L.key] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-6) max = min + 1;
  const Y = (v) => h - padB - ((v - min) / (max - min)) * (h - padT - padB);

  // grid
  ctx.strokeStyle = ink + '0.13)';
  ctx.fillStyle = ink + '0.5)';
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const v = min + (max - min) * (g / 3);
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(v), padL - 5, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let g = 0; g <= 3; g++) {
    const v = x0 + (x1 - x0) * (g / 3);
    ctx.fillText('d' + Math.round(v), X(v), h - padB + 4);
  }

  for (const L of lines) {
    ctx.strokeStyle = L.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    series.forEach((s, i) => {
      const px = X(s[xKey] ?? 0), py = Y(s[L.key] ?? 0);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
}

function fmt(v) {
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (a >= 10) return v.toFixed(0);
  return v.toFixed(a < 1 ? 2 : 1);
}

/** Age pyramid as horizontal bars, drawn as HTML for the report. */
export function ageBarsHtml(buckets) {
  const max = Math.max(1, ...Object.values(buckets));
  return Object.entries(buckets).map(([k, n]) =>
    `<div class="bar-row"><span class="bar-label">${k}</span>
      <span class="bar-track" style="background:rgba(42,35,26,0.10)"><span class="bar-fill" style="width:${(n / max) * 100}%;background:#a9751f"></span></span>
      <span class="bar-val">${n}</span></div>`).join('');
}
