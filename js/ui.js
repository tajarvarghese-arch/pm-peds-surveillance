// Small DOM helpers shared by tabs. Deliberately not a framework.

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function panel(title, sub, bodyHTML, { tight = false } = {}) {
  return `<section class="panel">
    <h2>${title}${sub ? `<span class="sub">${sub}</span>` : ''}</h2>
    <div class="panel-body${tight ? ' tight' : ''}">${bodyHTML}</div>
  </section>`;
}

export function tile(label, value, foot, cls = '') {
  return `<div class="tile">
    <div class="label">${label}</div>
    <div class="value ${cls}">${value}</div>
    <div class="foot">${foot ?? ''}</div>
  </div>`;
}

export function num(v, dp = 2, suffix = '') {
  if (v === null || v === undefined || Number.isNaN(v)) return '<span style="color:#4b5a6b">--</span>';
  return `${(+v).toFixed(dp)}${suffix}`;
}

export function delta(v, { dp = 1, suffix = '%', invert = false, noisy = false } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) {
    return '<span class="delta flat">--</span>';
  }
  // A move inside the published rounding step is not a direction.
  if (noisy) {
    return `<span class="delta flat" title="within reporting resolution (CDC publishes 1 decimal place)">
      ≈ ${v > 0 ? '+' : ''}${v.toFixed(dp)}${suffix} <span style="color:#4b5a6b">noise</span></span>`;
  }
  const rising = v > 0.5;
  const falling = v < -0.5;
  // For disease signals, rising is bad -- hence up=red unless inverted.
  const cls = rising ? (invert ? 'down' : 'up') : falling ? (invert ? 'up' : 'down') : 'flat';
  const arrow = rising ? '▲' : falling ? '▼' : '■';
  return `<span class="delta ${cls}">${arrow} ${v > 0 ? '+' : ''}${v.toFixed(dp)}${suffix}</span>`;
}

/** Level badge honouring the tier colour classes. */
export function levelBadge(text, cls, solid = true) {
  return `<span class="badge ${solid ? 'solid bg-' + cls : 's-' + cls}">${text}</span>`;
}

export function labelsFrom(points, fmt = 'short') {
  return points.map((p) => {
    const d = new Date(p.t + 'T00:00:00Z');
    if (fmt === 'year') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  });
}

export function valuesFrom(points) {
  return points.map((p) => (p.v === null || Number.isNaN(p.v) ? null : +p.v.toFixed(3)));
}

export function empty(msg) {
  return `<div class="empty">${msg}</div>`;
}

export function noteGap(gap) {
  return `<div class="note gap"><strong>${gap.wanted}</strong> — <span class="s-elevated">${gap.status}</span><br>${gap.detail}<br><span style="color:#7f8ea0">Substituted: ${gap.using}</span></div>`;
}
