// 六個世界的原創棲地場景（分層 SVG），以及全班里程碑裝飾。全部由程式繪製。
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v);
    kids.flat().forEach(k => k && e.append(k));
    return e;
};
const W = 800, H = 360;
const grad = (id, stops, vertical = true) => el('linearGradient', { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 },
    ...stops.map(([o, c]) => el('stop', { offset: o, 'stop-color': c })));
const tree = (x, y, s = 1, leaf = '#3fa34d') => el('g', { transform: `translate(${x} ${y}) scale(${s})` },
    el('rect', { x: -6, y: -10, width: 12, height: 40, rx: 4, fill: '#7a5232' }), el('circle', { cx: 0, cy: -26, r: 26, fill: leaf }), el('circle', { cx: -18, cy: -12, r: 16, fill: leaf }), el('circle', { cx: 18, cy: -12, r: 16, fill: leaf }));
const cloud = (x, y, s = 1, fill = '#ffffff', op = 0.9) => el('g', { transform: `translate(${x} ${y}) scale(${s})`, opacity: op },
    el('ellipse', { cx: 0, cy: 0, rx: 46, ry: 18, fill }), el('circle', { cx: -16, cy: -10, r: 18, fill }), el('circle', { cx: 14, cy: -14, r: 22, fill }));

const SCENES = {
    land: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#9fdcff'], [1, '#e8f8ff']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        el('circle', { cx: 690, cy: 70, r: 38, fill: '#ffe46b' }), cloud(160, 70, 1.1), cloud(470, 50, 0.8),
        el('path', { d: `M0 230 Q160 160 330 220 T800 200 V${H} H0Z`, fill: '#8ccf6a' }), el('path', { d: `M0 270 Q220 220 420 262 T800 250 V${H} H0Z`, fill: '#6dbb55' }),
        tree(80, 230, 1.1), tree(720, 220, 1.2, '#2f8f45'), tree(600, 250, 0.8), el('path', { d: `M330 ${H} Q360 300 420 300 T520 ${H}Z`, fill: '#c9b38a', opacity: 0.6 })],
    ocean: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#4fc3f7'], [0.6, '#1565c0'], [1, '#0d3a7a']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        ...Array.from({ length: 5 }, (_, i) => el('path', { d: `M${i * 170 - 40} 0 L${i * 170 + 30} 0 L${i * 170 + 120} ${H} L${i * 170 + 40} ${H}Z`, fill: '#ffffff', opacity: 0.05 })),
        el('path', { d: `M0 300 Q200 280 400 300 T800 296 V${H} H0Z`, fill: '#f2d9a6' }),
        ...[[90, 300, '#ff7aa2'], [150, 304, '#ffb347'], [660, 298, '#c79bff'], [720, 302, '#ff7a6b']].map(([x, y, c]) => el('path', { d: `M${x} ${y} q-14 -30 -6 -50 q8 18 6 30 q8 -26 20 -34 q-2 26 -10 54Z`, fill: c })),
        ...[[260, 120], [420, 80], [560, 160], [340, 200]].map(([x, y]) => el('circle', { cx: x, cy: y, r: 6, fill: 'none', stroke: '#e3f6ff', 'stroke-width': 2, opacity: 0.7 }))],
    sky: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#ffd6e8'], [0.5, '#bfe3ff'], [1, '#e9f6ff']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        el('circle', { cx: 120, cy: 90, r: 46, fill: '#fff3b0', opacity: 0.9 }), cloud(260, 110, 1.4), cloud(560, 80, 1.2), cloud(700, 200, 1.0), cloud(120, 250, 1.3), cloud(420, 290, 1.6),
        el('path', { d: `M0 ${H} Q120 300 260 330 T520 320 T800 330 V${H}Z`, fill: '#ffffff' })],
    tech: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#0b1530'], [1, '#1b2b55']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        ...[[40, 120, 70], [130, 80, 60], [210, 140, 50], [560, 100, 70], [650, 60, 60], [730, 130, 60]].map(([x, h, w]) => el('g', {},
            el('rect', { x, y: 260 - h, width: w, height: h, fill: '#22345f' }),
            ...Array.from({ length: Math.floor(h / 22) }, (_, r) => el('rect', { x: x + 10, y: 260 - h + 10 + r * 22, width: w - 20, height: 6, fill: '#00e5ff', opacity: 0.35 })))),
        el('rect', { x: 0, y: 260, width: W, height: 100, fill: '#13213f' }),
        ...Array.from({ length: 9 }, (_, i) => el('line', { x1: 400, y1: 260, x2: i * 100, y2: H, stroke: '#00e5ff', opacity: 0.25 })),
        ...[280, 300, 325, 355].map(y => el('line', { x1: 0, y1: y, x2: W, y2: y, stroke: '#00e5ff', opacity: 0.2 }))],
    prehistoric: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#ffb680'], [1, '#ffe2b8']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        el('path', { d: 'M520 230 L610 90 L640 110 L660 90 L740 230Z', fill: '#8a5a44' }), el('path', { d: 'M612 92 q14 -30 6 -60 q20 20 18 64Z', fill: '#cfcfcf', opacity: 0.8 }),
        el('path', { d: `M0 240 Q200 200 400 240 T800 236 V${H} H0Z`, fill: '#a7b86a' }), el('path', { d: `M0 290 Q260 260 480 292 T800 286 V${H} H0Z`, fill: '#8aa356' }),
        ...[[70, 260], [140, 270], [700, 270]].map(([x, y]) => el('g', {}, ...[-40, -15, 10, 35].map(a => el('path', { d: `M${x} ${y} q${a} -40 ${a * 1.6} -70`, stroke: '#4f7a3a', 'stroke-width': 6, fill: 'none', 'stroke-linecap': 'round' }))))],
    fantasy: (id) => [el('defs', {}, grad(`${id}s`, [[0, '#2a1a5e'], [0.7, '#6a3fa0'], [1, '#c58bd9']])), el('rect', { width: W, height: H, fill: `url(#${id}s)` }),
        el('circle', { cx: 650, cy: 80, r: 40, fill: '#fff8d6' }), el('circle', { cx: 664, cy: 70, r: 36, fill: '#3a2470' }),
        ...Array.from({ length: 30 }, (_, i) => el('circle', { cx: (i * 137) % W, cy: (i * 61) % 180, r: (i % 3) + 1, fill: '#fff', opacity: 0.8 })),
        el('path', { d: `M0 260 Q200 220 400 262 T800 250 V${H} H0Z`, fill: '#3f2a74' }),
        ...[[120, 290, '#7ef9ff'], [210, 300, '#ff9df0'], [600, 296, '#b7ff8a'], [690, 288, '#ffe46b']].map(([x, y, c]) => el('g', {},
            el('rect', { x: x - 4, y: y - 18, width: 8, height: 22, rx: 3, fill: '#efe6ff' }), el('path', { d: `M${x - 18} ${y - 16} q18 -26 36 0Z`, fill: c, opacity: 0.9 })))],
};

/** 全班里程碑裝飾（依序出現在場景前景） */
const DECOR = [
    (g) => g.append(...Array.from({ length: 7 }, (_, i) => el('circle', { cx: 300 + i * 34, cy: 330 - (i % 2) * 6, r: 3, fill: '#fff6a8' }))),
    (g, id) => g.append(el('path', { d: 'M40 210 Q160 90 280 210', stroke: `url(#${id}rb)`, 'stroke-width': 18, fill: 'none', opacity: 0.75 })),
    (g) => g.append(el('g', {}, el('rect', { x: 740, y: 230, width: 14, height: 70, fill: '#7a5232' }), el('circle', { cx: 747, cy: 210, r: 40, fill: '#3f9a4a' }), el('rect', { x: 722, y: 218, width: 50, height: 30, rx: 4, fill: '#c98a55' }), el('path', { d: 'M716 220 L747 196 L778 220Z', fill: '#b0563a' }))),
    (g) => g.append(el('g', {}, el('ellipse', { cx: 400, cy: 336, rx: 46, ry: 12, fill: '#9cd3ff' }), el('rect', { x: 394, y: 300, width: 12, height: 34, fill: '#d9dee6' }), el('path', { d: 'M400 300 q-24 -10 -30 14 M400 300 q24 -10 30 14', stroke: '#9cd3ff', 'stroke-width': 4, fill: 'none' }))),
    (g) => g.append(el('g', {}, el('rect', { x: 30, y: 150, width: 26, height: 150, fill: '#d9dee6' }), el('path', { d: 'M24 150 L43 120 L62 150Z', fill: '#5b7cfa' }), el('circle', { cx: 43, cy: 172, r: 7, fill: '#ffe46b' }))),
    (g) => g.append(el('g', {}, el('rect', { x: 560, y: 286, width: 70, height: 16, fill: '#cfcfcf' }), el('rect', { x: 576, y: 230, width: 38, height: 58, fill: '#e6e6e6' }), el('path', { d: 'M576 230 L595 212 L614 230Z', fill: '#ffd23f' }))),
];

/** 角色站位（12 個基本＋額外特殊收藏），x/y 為腳底位置，s 為縮放 */
export const SLOTS = [[110, 300, 0.9], [230, 318, 1], [350, 300, 0.85], [470, 320, 1], [590, 300, 0.9], [700, 322, 1],
    [170, 250, 0.7], [300, 246, 0.68], [430, 250, 0.7], [560, 244, 0.66], [660, 252, 0.7], [380, 210, 0.55],
    [60, 330, 0.7], [760, 336, 0.7], [520, 336, 0.7], [270, 340, 0.7]];

let seq = 0;
/** 產生棲地 SVG：world、decorLevel（已達成的里程碑數） → { svg, layer }（layer 給角色放置） */
export const sceneSVG = (world, { decorLevel = 0, label = '' } = {}) => {
    const id = `sc${++seq}`;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: `scene scene-${world}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid slice' },
        el('defs', {}, grad(`${id}rb`, [[0, '#ff6b6b'], [0.25, '#ffd23f'], [0.5, '#39ff88'], [0.75, '#4aa3ff'], [1, '#b06cff']], false)),
        ...(SCENES[world] || SCENES.land)(id));
    const decor = el('g', { class: 'scene-decor' });
    DECOR.slice(0, decorLevel).forEach(f => f(decor, id));
    svg.append(decor);
    const layer = el('g', { class: 'scene-creatures' });
    svg.append(layer);
    return { svg, layer };
};

/** 把一個角色 SVG 放到場景（巢狀 svg）。idx 決定站位；回傳外層 g（供互動動畫） */
export const placeInScene = (layer, creature, idx, { title = '', onClick = null } = {}) => {
    const [x, y, s] = SLOTS[idx % SLOTS.length];
    const size = 120 * s;
    const g = el('g', { class: 'scene-actor', transform: `translate(${x - size / 2} ${y - size})`, tabindex: onClick ? 0 : null, role: onClick ? 'button' : null, 'aria-label': title || null });
    g.style.setProperty('--i', String(idx));   // 用 CSSOM 設定（學生頁面的 CSP 不允許 style 屬性）
    creature.setAttribute('width', size); creature.setAttribute('height', size);
    const wrap = el('g', { class: 'actor-bob' }); wrap.append(creature);
    g.append(wrap);
    if (title) g.append(el('title', {}, title));
    if (onClick) { g.addEventListener('click', () => onClick(g)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(g); } }); }
    layer.append(g);
    return g;
};
