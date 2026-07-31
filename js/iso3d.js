// Isometric ridgeline renderer.
//
// Why 3D here when 3D is usually a mistake: depth maps to an actual dimension
// (season), not to decoration. Each ridge is one respiratory season over its
// week-of-season axis, so the receding axis carries real information and the
// eye can compare shapes without reading a legend.
//
// Hand-rolled SVG rather than a library: nothing in the Chart.js family does
// axonometric projection, and the whole thing is ~200 lines of trigonometry.

const DEG = Math.PI / 180;

/**
 * Rotate world (x, y, z) by yaw about the vertical axis then pitch about the
 * horizontal, and return screen coordinates plus a depth key for painter
 * ordering.
 *   x = week along the season      y = value (height)      z = season
 */
function project(x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;

  return { sx: x1, sy: -y2, depth: z2 };
}

/**
 * @param {HTMLElement} host        container to render into
 * @param {object} model
 *   model.axis     number[]                week-of-season order, e.g. 27..52,1..26
 *   model.ridges   [{key,label,values:Map,color,width,dash,fill,current}]
 *   model.maxV     number                  height normalisation
 *   model.monthTicks [{at:index,label}]
 * @param {object} view  {yaw, pitch}  degrees
 */
export function renderIso(host, model, view) {
  const { axis, ridges, maxV, monthTicks = [] } = model;
  const yaw = (view.yaw ?? -28) * DEG;
  const pitch = (view.pitch ?? 58) * DEG;

  // World extents, tuned so the projected bounding box lands near the 1.7:1
  // aspect of the host panel -- otherwise SVG's default "meet" fit letterboxes
  // the scene and it renders at half the available width.
  const SPAN_X = 520;
  const SPAN_Z = 16 * Math.max(1, ridges.length - 1) || 16;
  const HEIGHT = 96;

  const xAt = (i) => (i / Math.max(1, axis.length - 1)) * SPAN_X - SPAN_X / 2;
  const zAt = (i) => (ridges.length === 1 ? 0 : (i / (ridges.length - 1)) * SPAN_Z - SPAN_Z / 2);
  const yAt = (v) => (v == null ? null : (v / (maxV || 1)) * HEIGHT);

  const pts = [];
  const push = (p) => { pts.push(p); return p; };

  // ---- floor grid ---------------------------------------------------------
  const floor = [];
  for (const t of monthTicks) {
    const a = push(project(xAt(t.at), 0, zAt(0) - 6, yaw, pitch));
    const b = push(project(xAt(t.at), 0, zAt(ridges.length - 1) + 6, yaw, pitch));
    floor.push({ a, b, label: t.label });
  }
  // one baseline per season, so the receding axis is readable
  const baselines = ridges.map((r, i) => {
    const a = push(project(xAt(0), 0, zAt(i), yaw, pitch));
    const b = push(project(xAt(axis.length - 1), 0, zAt(i), yaw, pitch));
    return { a, b, label: r.label, current: r.current, color: r.color };
  });

  // ---- ridges -------------------------------------------------------------
  const built = ridges.map((r, i) => {
    const z = zAt(i);
    const top = [];
    const base = [];
    let depthSum = 0, depthN = 0;
    axis.forEach((w, xi) => {
      const v = r.values.get(w);
      const y = yAt(v);
      const pTop = y == null ? null : push(project(xAt(xi), y, z, yaw, pitch));
      const pBase = push(project(xAt(xi), 0, z, yaw, pitch));
      top.push(pTop);
      base.push(pBase);
      if (pTop) { depthSum += pTop.depth; depthN++; }
    });
    return { ...r, top, base, depth: depthN ? depthSum / depthN : project(0, 0, z, yaw, pitch).depth };
  });

  // ---- fit to viewBox -----------------------------------------------------
  const xs = pts.map((p) => p.sx), ys = pts.map((p) => p.sy);
  const pad = 14;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const W = maxX - minX, H = maxY - minY;
  const X = (p) => (p.sx - minX).toFixed(2);
  const Y = (p) => (p.sy - minY).toFixed(2);

  // Painter's algorithm: farthest first so near ridges occlude far ones.
  built.sort((a, b) => b.depth - a.depth);

  const svg = [];
  svg.push(`<svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="100%" height="100%"
    style="display:block;touch-action:none;cursor:grab" id="iso-svg">`);

  // month gridlines
  for (const f of floor) {
    svg.push(`<line x1="${X(f.a)}" y1="${Y(f.a)}" x2="${X(f.b)}" y2="${Y(f.b)}"
      stroke="#1e2936" stroke-width="0.6"/>`);
    svg.push(`<text x="${X(f.a)}" y="${(+Y(f.a) + 9).toFixed(1)}" fill="#4b5a6b"
      font-size="4.4" font-family="monospace" text-anchor="middle">${f.label}</text>`);
  }
  // season baselines + labels
  for (const b of baselines) {
    svg.push(`<line x1="${X(b.a)}" y1="${Y(b.a)}" x2="${X(b.b)}" y2="${Y(b.b)}"
      stroke="${b.current ? '#2d3f52' : '#16202b'}" stroke-width="0.6"/>`);
    svg.push(`<text x="${(+X(b.a) - 3).toFixed(1)}" y="${(+Y(b.a) + 1.6).toFixed(1)}"
      fill="${b.current ? b.color : '#4b5a6b'}" font-size="4.6" font-family="monospace"
      text-anchor="end" ${b.current ? 'font-weight="700"' : ''}>${b.label}</text>`);
  }

  // ridges
  for (const r of built) {
    // filled skirt under the curve, drawn as contiguous runs so gaps in the
    // data become gaps in the ribbon rather than a straight line across
    const runs = [];
    let run = null;
    r.top.forEach((p, i) => {
      if (p) { (run ||= []).push(i); } else if (run) { runs.push(run); run = null; }
    });
    if (run) runs.push(run);

    for (const idxs of runs) {
      if (idxs.length < 2) continue;
      const up = idxs.map((i) => `${X(r.top[i])},${Y(r.top[i])}`);
      const down = [...idxs].reverse().map((i) => `${X(r.base[i])},${Y(r.base[i])}`);
      svg.push(`<polygon points="${up.concat(down).join(' ')}" fill="${r.fill}"
        stroke="none"/>`);
      svg.push(`<polyline points="${up.join(' ')}" fill="none" stroke="${r.color}"
        stroke-width="${r.width}" ${r.dash ? `stroke-dasharray="${r.dash}"` : ''}
        stroke-linejoin="round" stroke-linecap="round"/>`);
      // The current season can be only a few weeks long against four full
      // ones. Mark every observed week and drop a stem to the floor so a short
      // stub still reads as a season rather than a stray tick.
      if (r.current) {
        for (const i of idxs) {
          svg.push(`<line x1="${X(r.base[i])}" y1="${Y(r.base[i])}"
            x2="${X(r.top[i])}" y2="${Y(r.top[i])}"
            stroke="${r.color}" stroke-width="0.5" opacity="0.5"/>`);
          svg.push(`<circle cx="${X(r.top[i])}" cy="${Y(r.top[i])}" r="1.5"
            fill="${r.color}"/>`);
        }
      }
    }
  }

  svg.push('</svg>');
  host.innerHTML = svg.join('');
  return host.querySelector('#iso-svg');
}

/** Drag to orbit. Returns a teardown function. */
export function attachOrbit(svg, view, onChange) {
  if (!svg) return () => {};
  let dragging = false, lastX = 0, lastY = 0;

  const down = (e) => {
    dragging = true;
    lastX = (e.touches ? e.touches[0].clientX : e.clientX);
    lastY = (e.touches ? e.touches[0].clientY : e.clientY);
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    const cx = (e.touches ? e.touches[0].clientX : e.clientX);
    const cy = (e.touches ? e.touches[0].clientY : e.clientY);
    view.yaw += (cx - lastX) * 0.35;
    // Clamp pitch: past ~85 the scene degenerates to a flat plan view, below
    // ~15 the ridges collapse into each other and nothing is readable.
    view.pitch = Math.max(15, Math.min(85, view.pitch - (cy - lastY) * 0.3));
    view.yaw = Math.max(-75, Math.min(75, view.yaw));
    lastX = cx; lastY = cy;
    onChange(view);
    e.preventDefault();
  };
  const up = () => { dragging = false; svg.style.cursor = 'grab'; };

  svg.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  svg.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);

  return () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', up);
  };
}
