/** Tiny DOM helpers — no framework, no build step. */

/** Create an element: h('div.foo', {attrs}, ...children) */
export function h(spec, props, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const el = document.createElement(tagPart || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export const frag = (...children) => append(document.createDocumentFragment(), children);

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function mount(el, ...children) { clear(el); return append(el, children); }

/** Inline SVG icon set (stroke-based, 24-grid). */
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.9 3.6-6.5 8-6.5s8 2.6 8 6.5',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  eyeOff: 'M3 3l18 18M10.6 10.7a2.6 2.6 0 0 0 3.6 3.7M6.6 6.8C4 8.4 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.3 4.3-.8M19.5 15.6C21.2 14 22 12 22 12s-3.6-6.5-10-6.5c-.7 0-1.3 0-2 .2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  chev: 'M9 5l7 7-7 7',
  chevDown: 'M5 9l7 7 7-7',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  filter: 'M3 5h18M6 12h12M10 19h4',
  shield: 'M12 3 5 6v6c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6l-7-3Z',
  shieldCheck: 'M12 3 5 6v6c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6l-7-3ZM9 12l2.2 2.2L15.5 10',
  alert: 'M12 3 2.5 20h19L12 3ZM12 9v5M12 17.2v.3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8.2v.3M12 11.5V16',
  zap: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  cpu: 'M8 8h8v8H8zM4 9V7a3 3 0 0 1 3-3h2M15 4h2a3 3 0 0 1 3 3v2M20 15v2a3 3 0 0 1-3 3h-2M9 20H7a3 3 0 0 1-3-3v-2',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.5ZM3 10h18M16.5 14.5h.5',
  card: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8ZM3 10.5h18M6.5 15H11',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13',
  refresh: 'M20 11a8 8 0 1 0-2.4 6.3M20 5.5V11h-5.5',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5 19 12 7 19.5v-15Z',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 16V4M7 8l5-5 5 5M4 20h16',
  copy: 'M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M3 11a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3.2 2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5',
  key: 'M14.5 9.5a4 4 0 1 0-4.2 4L9 15l-2 .3.3 2L5 19l1 3 2.8-1.5.4-2.6 2.3-2.3M16.6 7.4h.3',
  link: 'M9.5 14.5 14.5 9.5M8 12 6 14a3.5 3.5 0 0 0 5 5l2-2M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2',
  doc: 'M6 3h7l5 5v13H6V3ZM13 3v5h5M9 13h6M9 17h6',
  camera: 'M3 9a3 3 0 0 1 3-3h1.5L9 4h6l1.5 2H18a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Zm9 8.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5M16.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.6c2.4.7 4 2.5 4 5.4',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9ZM10 19a2.2 2.2 0 0 0 4 0',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c-2.5 3-2.5 15 0 18M12 3c2.5 3 2.5 15 0 18',
  database: 'M12 7.5c4.4 0 8-1 8-2.2S16.4 3 12 3 4 4 4 5.3s3.6 2.2 8 2.2ZM4 5.3v13.4C4 20 7.6 21 12 21s8-1 8-2.3V5.3M4 12c0 1.3 3.6 2.3 8 2.3s8-1 8-2.3',
  flame: 'M12 21c3.9 0 6-2.4 6-5.6 0-3.9-3.3-5.4-3.3-8.9 0-1.4.4-2.5.4-2.5S12 5 10.5 8.6C9.4 11.3 6 11.8 6 15.4 6 18.6 8.1 21 12 21Zm0-3.2c1.3 0 2.1-.9 2.1-2.1 0-1.6-1.8-2.2-1.8-3.7 0 0-1.9 1.3-2.3 2.9-.2.9.6 2.9 2 2.9Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  bookmark: 'M6 3h12v18l-6-4.5L6 21V3Z',
  scale: 'M12 4v16M7 20h10M12 7 5 9l3.5 5L12 9l3.5 5L19 9l-7-2Z',
  trophy: 'M7 4h10v4a5 5 0 0 1-10 0V4ZM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M9 15h6M12 13v4M8 20h8',
  lock: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14v10H5zM12 14v3',
  crown: 'M4 18h16M4 18l-1.5-9 5 4L12 6l4.5 7 5-4L20 18',
  medal: 'M8 3h8l-2 6H10L8 3ZM12 9a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 4v4',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM21 21l-5.2-5.2',
};

export function icon(name, props = {}) {
  const d = ICONS[name] || ICONS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', props.sw || '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (props.class) svg.setAttribute('class', props.class);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

export function sparkline(points, color = 'currentColor') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  if (!points.length) return svg;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((v, i) =>
    `${i ? 'L' : 'M'}${(i / (points.length - 1) * 100).toFixed(2)},${(30 - (v - min) / span * 26).toFixed(2)}`
  ).join(' ');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `${d} L100,32 L0,32 Z`);
  area.setAttribute('fill', color);
  area.setAttribute('opacity', '.14');
  svg.append(area, path);
  return svg;
}
