// Chart engine. Every chart on the site is created here, so legibility and
// motion are decided once rather than argued chart by chart.
//
// What this layer guarantees, whatever a tab passes in:
//   - readable type (12px sans, high-contrast ink) and a recessive grid
//   - a legend whose swatches look like the marks they name
//   - the latest value written at the end of each line, so nobody has to
//     trace a colour back to a legend to learn the current number
//   - a crosshair + tooltip sorted by value, with units
//   - motion that explains: lines draw left to right in time order, bars grow
//     from the baseline, and the newest point of the series that matters
//     pulses. Charts animate when they scroll into view, not while offscreen.
//   - none of the motion if the reader has asked for reduced motion.

const registry = new Map();

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

export const INK = {
  primary: '#eef3f8',
  secondary: '#b4c2d1',
  muted: '#8797a9',
  grid: '#18222d',
  axis: '#2d3f52',
  surface: '#0b0f14',
};

/**
 * Categorical series palette, in fixed order. Validated against this site's
 * dark surface (lightness band, chroma, colour-vision separation, contrast).
 * Deliberately distinct from the status colours (ok/watch/elevated/critical):
 * a series must never look like an alarm.
 */
export const SERIES = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  yellow: '#c98500',
  magenta: '#d55181',
  green: '#008300',
  violet: '#9085e9',
  red: '#e66767',
  // Emphasis + context, for charts whose story is one series against the rest.
  focus: '#22d3ee',
  context: '#7f8ea0',
  reference: '#c9d3de',
};

export const STATE_COLORS = { NY: SERIES.blue, NJ: SERIES.orange, CT: SERIES.aqua, US: SERIES.context };
export const AGE_COLORS = [SERIES.violet, SERIES.magenta, SERIES.yellow];

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = SANS;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = INK.secondary;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isClear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)/.test(String(c));

/** A dataset that only exists to bound a filled band -- never named or labelled. */
function isBand(ds) {
  if (!(isClear(ds.borderColor) || ds.borderWidth === 0)) return false;
  // A borderless BAR is a real series; only an invisible line, or a fill that
  // hangs off another dataset, is scaffolding.
  const bg = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor;
  return isClear(bg) || (ds.fill !== undefined && ds.fill !== false);
}

function lastPoint(chart, i) {
  const ds = chart.data.datasets[i];
  const meta = chart.getDatasetMeta(i);
  if (!meta || meta.hidden || !chart.isDatasetVisible(i)) return null;
  for (let k = ds.data.length - 1; k >= 0; k--) {
    const raw = ds.data[k];
    const v = raw && typeof raw === 'object' ? raw.y : raw;
    const el = meta.data[k];
    if (v !== null && v !== undefined && !Number.isNaN(+v) && el) {
      return { x: el.x, y: el.y, v: +v, k };
    }
  }
  return null;
}

export function fmtValue(v, unit = '') {
  if (v === null || v === undefined || Number.isNaN(+v)) return '--';
  const a = Math.abs(v);
  const s = a >= 10000 ? Math.round(v).toLocaleString('en-US')
    : a >= 100 ? (+v).toFixed(0)
    : a >= 10 ? (+v).toFixed(1)
    : (+v).toFixed(2);
  return s + unit;
}

const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** The one series the chart is about: flagged, else the heaviest solid line. */
function focusIndex(chart) {
  const dss = chart.data.datasets;
  let best = -1, bestW = 0;
  dss.forEach((ds, i) => {
    if (isBand(ds) || (ds.type && ds.type !== 'line')) return;
    if (ds.emphasis) { best = i; bestW = Infinity; return; }
    const w = ds.borderWidth ?? 2;
    const dashed = Array.isArray(ds.borderDash) && ds.borderDash.length;
    if (!dashed && w > bestW) { best = i; bestW = w; }
  });
  const named = dss.filter((d) => !isBand(d)).length;
  // With several equally-weighted lines nothing is "the" series.
  if (named > 1 && bestW !== Infinity) {
    const ties = dss.filter((d) => !isBand(d) && (d.borderWidth ?? 2) === bestW
      && !(Array.isArray(d.borderDash) && d.borderDash.length)).length;
    if (ties > 1) return -1;
  }
  return best;
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

/** Lines draw left to right -- time order -- by widening a clip rectangle. */
const revealPlugin = {
  id: 'reveal',
  beforeDatasetsDraw(chart) {
    const r = chart.$reveal;
    if (!r || r.p >= 1) return;
    const a = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.left - 2, a.top - 12, (a.width + 4) * easeOut(r.p), a.height + 24);
    ctx.clip();
    r.clipped = true;
  },
  afterDatasetsDraw(chart) {
    const r = chart.$reveal;
    if (r && r.clipped) { chart.ctx.restore(); r.clipped = false; }
  },
};

function startReveal(chart, duration = 1100) {
  if (REDUCED) { chart.$reveal = { p: 1, label: 1 }; return; }
  chart.$reveal = { p: 0, label: 0 };
  const t0 = performance.now();
  const tick = (now) => {
    if (!chart.ctx || !chart.canvas?.isConnected) return;
    const t = (now - t0) / duration;
    chart.$reveal.p = Math.min(1, t);
    chart.$reveal.label = Math.min(1, Math.max(0, (t - 1) / 0.35));
    chart.draw();
    if (t < 1.35) chart.$raf = requestAnimationFrame(tick);
  };
  chart.$raf = requestAnimationFrame(tick);
  // A backgrounded tab pauses animation frames. Never leave a chart half-drawn:
  // a timer settles it on the final frame whether or not the wipe ever ran.
  setTimeout(() => {
    if (!chart.ctx || !chart.canvas?.isConnected || chart.$reveal.label >= 1) return;
    cancelAnimationFrame(chart.$raf);
    chart.$reveal.p = 1;
    chart.$reveal.label = 1;
    chart.draw();
  }, duration * 1.35 + 400);
}

/** Air between the legend and the plot, which Chart.js does not offer. */
const legendGapPlugin = {
  id: 'legendGap',
  beforeInit(chart) {
    const fit = chart.legend?.fit;
    if (!fit) return;
    chart.legend.fit = function fitWithGap() {
      fit.call(this);
      if (this.options.display) this.height += 12;
    };
  },
};

/** Vertical rule at the hovered x, so a value can be read across series. */
const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'line') return;
    const act = chart.tooltip?.getActiveElements?.() || [];
    if (!act.length) return;
    const x = act[0].element.x;
    const a = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = 'rgba(180,194,209,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, a.top);
    ctx.lineTo(Math.round(x) + 0.5, a.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * Name + latest value at the end of each line. Identity stops depending on
 * colour-matching against a legend, and "what is it now" is answered in place.
 */
const endLabelPlugin = {
  id: 'endLabels',
  beforeLayout(chart) {
    if (chart.config.type !== 'line') return;
    const o = chart.options.plugins?.endLabels;
    if (o?.display === false) return;
    const items = labelTargets(chart);
    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 11.5px ${SANS}`;
    let w = 0;
    for (const it of items) w = Math.max(w, ctx.measureText(it.text).width);
    ctx.restore();
    const pad = chart.options.layout.padding;
    // Narrow charts cannot afford a wide gutter: shorten to the value alone.
    const room = chart.width * 0.26;
    chart.$endShort = w + 22 > room;
    pad.right = items.length ? Math.min(w + 22, Math.max(64, room)) : 8;
  },
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'line') return;
    const o = chart.options.plugins?.endLabels;
    if (o?.display === false) return;
    const alpha = chart.$reveal ? chart.$reveal.label : 1;
    if (alpha <= 0) return;

    const unit = chart.options.unit || '';
    const a = chart.chartArea;
    const { ctx } = chart;
    const focus = focusIndex(chart);
    const items = labelTargets(chart).map((it) => {
      const p = lastPoint(chart, it.i);
      return p ? { ...it, ...p } : null;
    }).filter(Boolean);
    if (!items.length) return;

    // Resolve collisions top to bottom, then pull back inside the plot.
    items.sort((p, q) => p.y - q.y);
    const GAP = 15;
    items.forEach((it) => { it.ly = Math.max(a.top + 6, Math.min(a.bottom - 6, it.y)); });
    for (let i = 1; i < items.length; i++) {
      if (items[i].ly - items[i - 1].ly < GAP) items[i].ly = items[i - 1].ly + GAP;
    }
    const over = items.at(-1).ly - (a.bottom - 4);
    if (over > 0) {
      items.at(-1).ly -= over;
      for (let i = items.length - 2; i >= 0; i--) {
        if (items[i + 1].ly - items[i].ly < GAP) items[i].ly = items[i + 1].ly - GAP;
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const isFocus = it.i === focus;
      const lx = Math.min(it.x + 11, chart.width - 4);

      // end dot with a surface ring, so it survives crossing other lines
      ctx.beginPath();
      ctx.arc(it.x, it.y, isFocus ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = it.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK.surface;
      ctx.stroke();

      if (Math.abs(it.ly - it.y) > 5) {
        ctx.beginPath();
        ctx.moveTo(it.x + 5, it.y);
        ctx.lineTo(lx - 2, it.ly);
        ctx.strokeStyle = 'rgba(135,151,169,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      const text = chart.$endShort ? fmtValue(it.v, unit) : `${it.name} ${fmtValue(it.v, unit)}`;
      ctx.font = `${isFocus ? 700 : 500} 11.5px ${SANS}`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK.surface;
      ctx.strokeText(text, lx, it.ly);
      ctx.fillStyle = isFocus ? INK.primary : INK.secondary;
      ctx.fillText(text, lx, it.ly);
    }
    ctx.restore();
  },
};

function labelTargets(chart) {
  const unit = chart.options.unit || '';
  const out = [];
  chart.data.datasets.forEach((ds, i) => {
    if (isBand(ds) || ds.endLabel === false) return;
    if (ds.type && ds.type !== 'line') return;
    if (!chart.isDatasetVisible(i)) return;
    const vals = (ds.data || []).map((d) => (d && typeof d === 'object' ? d.y : d))
      .filter((v) => v !== null && v !== undefined && !Number.isNaN(+v));
    if (!vals.length) return;
    const name = String(ds.shortLabel || ds.label || '').replace(/\s*\(current\)/i, '');
    out.push({ i, name, color: ds.borderColor, text: `${name} ${fmtValue(vals.at(-1), unit)}` });
  });
  // Past five, labels become the clutter they were meant to remove: keep only
  // the series the chart is about and let the legend + tooltip carry the rest.
  if (out.length > 5) {
    const f = focusIndex(chart);
    return out.filter((o) => o.i === f || chart.data.datasets[o.i].emphasis);
  }
  return out;
}

/** A soft pulse on the newest point of the focus series: "this is now". */
const pulsePlugin = {
  id: 'pulse',
  afterDraw(chart) {
    if (chart.config.type !== 'line' || REDUCED) return;
    if (chart.options.plugins?.pulse?.display === false) return;
    const host = chart.canvas.parentNode;
    if (!host) return;
    const f = focusIndex(chart);
    const ready = !chart.$reveal || chart.$reveal.p >= 1;
    const p = f >= 0 && ready ? lastPoint(chart, f) : null;
    let el = chart.$pulse;
    if (!p) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'chart-pulse';
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
      chart.$pulse = el;
    }
    el.hidden = false;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.setProperty('--pulse', chart.data.datasets[f].borderColor);
  },
  afterDestroy(chart) {
    if (chart.$raf) cancelAnimationFrame(chart.$raf);
    chart.$pulse?.remove();
    chart.$pulse = null;
  },
};

const PLUGINS = [revealPlugin, crosshairPlugin, endLabelPlugin, pulsePlugin, legendGapPlugin];

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

function styleScale(s, axis, unit) {
  const out = { ...s };
  out.grid = { color: INK.grid, drawTicks: false, display: axis !== 'x', ...(s.grid || {}) };
  out.border = { color: axis === 'x' ? INK.axis : 'transparent', ...(s.border || {}) };
  out.ticks = {
    color: INK.muted,
    font: { family: SANS, size: 11.5 },
    padding: 8,
    maxRotation: 0,
    ...(axis === 'x' ? { autoSkipPadding: 28, maxTicksLimit: 9 } : { maxTicksLimit: 6 }),
    ...(s.ticks || {}),
  };
  // Tabs used to style these by hand at 9px monospace; normalise them.
  out.ticks.color = INK.muted;
  out.ticks.font = { family: SANS, size: 11.5 };
  if (axis !== 'x' && unit && !s.ticks?.callback) {
    out.ticks.callback = (v) => `${+(+v).toFixed(2)}${unit}`;
  }
  if (out.title?.display) {
    out.title = { ...out.title, color: INK.muted, font: { family: SANS, size: 11.5, weight: '500' },
      padding: { bottom: 6, top: 4 } };
  }
  return out;
}

export function baseOpts(extra = {}, kind = 'line') {
  const unit = extra.unit || '';
  const scales = {};
  const given = extra.scales || {};
  for (const k of new Set(['x', 'y', ...Object.keys(given)])) {
    const axis = given[k]?.axis || (k.startsWith('x') ? 'x' : 'y');
    scales[k] = styleScale(given[k] || {}, extra.indexAxis === 'y' ? (axis === 'x' ? 'y' : 'x') : axis, unit);
  }
  if (extra.indexAxis === 'y') {
    // horizontal bars: the value axis is x, and y holds the category names --
    // every one of which must be printed, or bars sit beside no label at all.
    scales.x.grid.display = true;
    scales.y.grid.display = false;
    scales.y.ticks.autoSkip = false;
    delete scales.y.ticks.maxTicksLimit;
    scales.x.ticks.maxTicksLimit = 7;
    if (unit && !given.x?.ticks?.callback) scales.x.ticks.callback = (v) => `${+(+v).toFixed(2)}${unit}`;
  }

  const rest = Object.fromEntries(Object.entries(extra)
    .filter(([k]) => !['plugins', 'scales', 'unit'].includes(k)));
  const xp = extra.plugins || {};

  let delayed = false;
  const animation = REDUCED ? false
    : kind === 'line' ? false   // lines use the reveal wipe instead
    : {
      duration: 750,
      easing: 'easeOutCubic',
      onComplete: () => { delayed = true; },
      delay: (c) => (c.type === 'data' && c.mode === 'default' && !delayed
        ? Math.min(c.dataIndex * 16, 520) : 0),
    };

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation,
    unit,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
    ...rest,
    plugins: {
      ...xp,
      legend: {
        display: true,
        position: 'top',
        align: 'start',
        ...(xp.legend || {}),
        labels: {
          color: INK.secondary,
          font: { family: SANS, size: 12 },
          usePointStyle: true,
          pointStyleWidth: 22,
          boxHeight: 7,
          padding: 14,
          filter: (item, data) => !isBand(data.datasets[item.datasetIndex]),
          generateLabels: (chart) => {
            const base = Chart.defaults.plugins.legend.labels.generateLabels(chart);
            return base.map((l) => {
              const ds = chart.data.datasets[l.datasetIndex];
              const t = ds.type || chart.config.type;
              const solid = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor;
              if (t === 'line') {
                return { ...l, pointStyle: 'line', strokeStyle: ds.borderColor, lineWidth: 3,
                  lineDash: ds.borderDash || [], fillStyle: ds.borderColor };
              }
              return { ...l, pointStyle: 'rectRounded', lineWidth: 0,
                fillStyle: isClear(solid) ? ds.borderColor : solid };
            });
          },
          ...(xp.legend?.labels || {}),
        },
      },
      tooltip: {
        backgroundColor: 'rgba(8,12,17,0.96)',
        borderColor: INK.axis,
        borderWidth: 1,
        titleColor: INK.primary,
        bodyColor: INK.secondary,
        titleFont: { family: SANS, size: 12.5, weight: '600' },
        bodyFont: { family: SANS, size: 12.5 },
        padding: 11,
        cornerRadius: 6,
        caretSize: 5,
        boxPadding: 5,
        usePointStyle: true,
        filter: (item) => !isBand(item.dataset),
        itemSort: (a, b) => (b.parsed?.y ?? 0) - (a.parsed?.y ?? 0),
        callbacks: {
          label: (c) => {
            const v = c.chart.options.indexAxis === 'y' ? c.parsed.x : c.parsed.y;
            return ` ${c.dataset.label}: ${fmtValue(v, unit)}`;
          },
          labelColor: (c) => {
            const bg = Array.isArray(c.dataset.backgroundColor)
              ? c.dataset.backgroundColor[c.dataIndex] : c.dataset.backgroundColor;
            const col = (c.dataset.type || c.chart.config.type) === 'line' || isClear(bg)
              ? c.dataset.borderColor : bg;
            return { borderColor: col, backgroundColor: col, borderWidth: 0 };
          },
          ...(xp.tooltip?.callbacks || {}),
        },
        ...Object.fromEntries(Object.entries(xp.tooltip || {}).filter(([k]) => k !== 'callbacks')),
      },
    },
    scales,
  };
}

// ---------------------------------------------------------------------------
// mounting -- charts are built when they scroll into view, so the motion is
// seen by the reader rather than spent offscreen.
// ---------------------------------------------------------------------------

function mount(canvas, build) {
  destroy(canvas);
  const key = canvas.id || canvas;
  const entry = { chart: null, io: null };
  registry.set(key, entry);
  const run = () => { if (canvas.isConnected && !entry.chart) entry.chart = build(); };
  entry.run = run;
  if (REDUCED || typeof IntersectionObserver === 'undefined') { run(); return entry; }
  entry.io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    entry.io.disconnect();
    entry.io = null;
    run();
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
  entry.io.observe(canvas);
  return entry;
}

export function line(canvas, { labels, datasets, options = {} }) {
  return mount(canvas, () => {
    const named = datasets.filter((d) => !isBand(d));
    const c = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map((d) => {
          const out = {
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: INK.surface,
            pointHoverBackgroundColor: d.borderColor,
            tension: 0.3,
            spanGaps: true,
            borderJoinStyle: 'round',
            borderCapStyle: 'round',
            ...d,
          };
          // Hairlines vanish on a dark surface. Nothing thinner than 1.5px.
          if (!isBand(out)) out.borderWidth = Math.max(1.5, out.borderWidth);
          if (out.emphasis) out.borderWidth = Math.max(3, out.borderWidth);
          return out;
        }),
      },
      options: baseOpts({
        ...options,
        plugins: {
          ...(options.plugins || {}),
          // One series needs no legend box: the panel title already names it.
          legend: { ...(named.length < 2 ? { display: false } : {}), ...(options.plugins?.legend || {}) },
        },
      }, 'line'),
      plugins: PLUGINS,
    });
    startReveal(c);
    return c;
  });
}

export function bar(canvas, { labels, datasets, options = {} }) {
  return mount(canvas, () => {
    const horizontal = options.indexAxis === 'y';
    const named = datasets.filter((d) => !isBand(d));
    return new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map((d) => (d.type === 'line'
          ? { borderWidth: 2, pointRadius: 0, tension: 0.3, ...d }
          : {
            borderWidth: 0,
            borderRadius: 3,
            borderSkipped: horizontal ? 'left' : 'bottom',
            maxBarThickness: 26,
            categoryPercentage: 0.82,
            barPercentage: 0.9,
            ...d,
          })),
      },
      options: baseOpts({
        ...options,
        plugins: {
          ...(options.plugins || {}),
          legend: { ...(named.length < 2 ? { display: false } : {}), ...(options.plugins?.legend || {}) },
        },
      }, 'bar'),
      plugins: [crosshairPlugin, legendGapPlugin],
    });
  });
}

/** Scatter/bubble, same theming and registry as line/bar. */
export function scatter(canvas, { datasets, options = {} }) {
  return mount(canvas, () => new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: { datasets },
    options: (() => {
      const o = baseOpts({ interaction: { mode: 'nearest', intersect: true }, ...options }, 'scatter');
      o.scales.x.grid.display = true;
      // Scatter tooltips are per-point; the index-mode callbacks do not apply.
      if (!options.plugins?.tooltip?.callbacks?.label) delete o.plugins.tooltip.callbacks.label;
      delete o.plugins.tooltip.itemSort;
      return o;
    })(),
  }));
}

/**
 * Build every chart that is still waiting to scroll into view. Printing needs
 * this -- a page printed from the top would otherwise have blank charts below
 * the fold -- and so does anything that inspects the page without scrolling.
 */
export function buildAll() {
  let n = 0;
  for (const e of registry.values()) {
    if (e.chart) continue;
    e.io?.disconnect();
    e.io = null;
    e.run?.();
    if (e.chart) {
      n++;
      if (e.chart.$reveal) { e.chart.$reveal.p = 1; e.chart.$reveal.label = 1; e.chart.draw(); }
    }
  }
  return n;
}
if (typeof window !== 'undefined') window.addEventListener('beforeprint', buildAll);

export function destroy(canvas) {
  const key = canvas.id || canvas;
  const e = registry.get(key);
  if (!e) return;
  e.io?.disconnect();
  e.chart?.destroy();
  registry.delete(key);
}

export function destroyAll() {
  for (const e of registry.values()) { e.io?.disconnect(); e.chart?.destroy(); }
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
export function sparkline(points, { color = SERIES.focus, w = 120, h = 28 } = {}) {
  const vals = points.map((p) => p.v).filter((v) => v !== null && !Number.isNaN(v));
  if (vals.length < 2) return `<span style="color:${INK.muted}">--</span>`;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const y = (v) => h - ((v - min) / span) * (h - 8) - 4;
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d} L${w},${h} L0,${h} Z" fill="${color}" opacity="0.10" class="spark-area"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" pathLength="1"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" class="spark-line"/>
  </svg>`;
}

/** Sequential ramp for heatmaps: cold slate -> amber -> red. */
export function heatColor(t) {
  if (t === null || Number.isNaN(t)) return '#0b0f14';
  const x = Math.max(0, Math.min(1, t));
  const stops = [
    [0.0, [16, 24, 33]],
    [0.2, [23, 58, 84]],
    [0.45, [34, 170, 200]],
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

/** Scale legend for the heat ramp, so colour can be read back to a value. */
export function heatLegend(min, max, unit = '%') {
  const stops = [0, 0.2, 0.45, 0.7, 0.88, 1].map((t) => `${heatColor(t)} ${t * 100}%`).join(',');
  return `<div class="heat-legend">
    <span>${fmtValue(min, unit)}</span>
    <i style="background:linear-gradient(90deg,${stops})"></i>
    <span>${fmtValue(max, unit)}</span>
  </div>`;
}

export function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
