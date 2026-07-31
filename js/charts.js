// Chart.js wrappers pre-themed for the terminal. All charts register here so a
// tab switch can dispose cleanly instead of leaking canvases.

const registry = new Map();

const GRID = '#1e2936';
const TICK = '#7f8ea0';

export function baseOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 4 } },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: TICK, font: { family: 'monospace', size: 10 },
          boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 10,
        },
      },
      tooltip: {
        backgroundColor: '#0b0f14',
        borderColor: '#2d3f52',
        borderWidth: 1,
        titleColor: '#d8e0e8',
        bodyColor: '#d8e0e8',
        titleFont: { family: 'monospace', size: 11 },
        bodyFont: { family: 'monospace', size: 11 },
        padding: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
      },
      ...(extra.plugins || {}),
    },
    scales: {
      x: {
        grid: { color: GRID, drawTicks: false },
        border: { color: GRID },
        ticks: {
          color: TICK, font: { family: 'monospace', size: 9 },
          maxRotation: 0, autoSkipPadding: 18,
        },
        ...(extra.scales?.x || {}),
      },
      y: {
        grid: { color: GRID, drawTicks: false },
        border: { color: GRID },
        ticks: { color: TICK, font: { family: 'monospace', size: 9 } },
        ...(extra.scales?.y || {}),
      },
      ...(extra.scales || {}),
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['plugins', 'scales'].includes(k))),
  };
}

export function line(canvas, { labels, datasets, options = {} }) {
  destroy(canvas);
  const c = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.25,
        spanGaps: true,
        ...d,
      })),
    },
    options: baseOpts(options),
  });
  registry.set(canvas.id || canvas, c);
  return c;
}

export function bar(canvas, { labels, datasets, options = {} }) {
  destroy(canvas);
  const c = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: datasets.map((d) => ({ borderWidth: 0, ...d })) },
    options: baseOpts(options),
  });
  registry.set(canvas.id || canvas, c);
  return c;
}

export function destroy(canvas) {
  const key = canvas.id || canvas;
  const existing = registry.get(key);
  if (existing) { existing.destroy(); registry.delete(key); }
}

export function destroyAll() {
  for (const c of registry.values()) c.destroy();
  registry.clear();
}

/** Translucent band dataset for percentile envelopes. */
export function bandDatasets(label, lo, hi, color) {
  return [
    { label: `${label} lo`, data: lo, borderWidth: 0, pointRadius: 0,
      fill: false, backgroundColor: 'transparent', borderColor: 'transparent' },
    { label: `${label} hi`, data: hi, borderWidth: 0, pointRadius: 0,
      fill: '-1', backgroundColor: color, borderColor: 'transparent' },
  ];
}

/** Inline SVG sparkline -- cheap, no Chart.js instance, good for table cells. */
export function sparkline(points, { color = '#22d3ee', w = 120, h = 28 } = {}) {
  const vals = points.map((p) => p.v).filter((v) => v !== null && !Number.isNaN(v));
  if (vals.length < 2) return '<span style="color:#4b5a6b">--</span>';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const d = vals
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 3) - 1.5).toFixed(1)}`)
    .join(' ');
  const lastX = w;
  const lastY = h - ((vals[vals.length - 1] - min) / span) * (h - 3) - 1.5;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.2"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="1.8" fill="${color}"/>
  </svg>`;
}

/** Sequential ramp for heatmaps: cold slate -> amber -> red. */
export function heatColor(t) {
  if (t === null || Number.isNaN(t)) return '#0b0f14';
  const x = Math.max(0, Math.min(1, t));
  const stops = [
    [0.0, [11, 15, 20]],
    [0.2, [23, 47, 66]],
    [0.45, [34, 211, 238]],
    [0.7, [251, 191, 36]],
    [0.88, [249, 115, 22]],
    [1.0, [239, 68, 68]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (x - t0) / (t1 - t0 || 1);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(239,68,68)';
}

export function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
