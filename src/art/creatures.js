// 原創參數化 SVG 角色（佔位插畫）。全部由本專案程式碼繪製，不使用任何外部圖檔或既有遊戲角色造型。
// 正式插畫完成前，UI 一律標示「原創佔位插畫（待美術定稿）」。授權紀錄：docs/ASSET-LICENSES.md
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v);
    kids.flat().forEach(k => k && e.append(k));
    return e;
};
const shade = (hex, amt) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
    return `#${[f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
};
const INK = '#2b2233';

// ------------------------------------------------------------------ 共用部件
const eyes = (x1, x2, y, r = 4.2) => [x1, x2].map(x => el('g', {},
    el('ellipse', { cx: x, cy: y, rx: r, ry: r * 1.15, fill: INK }),
    el('circle', { cx: x + r * 0.35, cy: y - r * 0.45, r: r * 0.38, fill: '#fff' })));
const blush = (x1, x2, y) => [x1, x2].map(x => el('ellipse', { cx: x, cy: y, rx: 4, ry: 2.4, fill: '#ff8fa3', opacity: 0.55 }));
const smile = (x, y, w = 5) => el('path', { d: `M${x - w} ${y} q${w} ${w * 0.8} ${w * 2} 0`, stroke: INK, 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round' });
const shadow = () => el('ellipse', { cx: 60, cy: 108, rx: 34, ry: 5, fill: '#000', opacity: 0.18 });

const ears = (type, c, a, hx, hy, hr) => {
    const L = hx - hr * 0.62, R = hx + hr * 0.62, top = hy - hr * 0.78;
    switch (type) {
        case 'pointy': return [L, R].map((x, i) => el('path', { d: `M${x - 9} ${top + 8} L${x + (i ? 3 : -3)} ${top - 12} L${x + 9} ${top + 6} Z`, fill: c, stroke: shade(c, -0.18), 'stroke-width': 1.2 }));
        case 'cat': return [L, R].map((x, i) => el('path', { d: `M${x - 8} ${top + 6} L${x + (i ? 2 : -2)} ${top - 10} L${x + 8} ${top + 6} Z`, fill: c }));
        case 'huge': return [L - 3, R + 3].map((x, i) => el('g', {}, el('path', { d: `M${x - 11} ${top + 12} L${x + (i ? 10 : -10)} ${top - 26} L${x + 11} ${top + 8} Z`, fill: c }),
            el('path', { d: `M${x - 6} ${top + 9} L${x + (i ? 8 : -8)} ${top - 18} L${x + 6} ${top + 7} Z`, fill: a })));
        case 'floppy': return [L - 4, R + 4].map((x, i) => el('ellipse', { cx: x, cy: top + 14, rx: 7, ry: 14, fill: shade(c, -0.2), transform: `rotate(${i ? -20 : 20} ${x} ${top + 14})` }));
        case 'bunny': return [L + 2, R - 2].map((x, i) => el('g', {}, el('ellipse', { cx: x, cy: top - 12, rx: 6.5, ry: 18, fill: c, transform: `rotate(${i ? 10 : -10} ${x} ${top})` }),
            el('ellipse', { cx: x, cy: top - 12, rx: 3.2, ry: 13, fill: '#ffc8dc', transform: `rotate(${i ? 10 : -10} ${x} ${top})` })));
        case 'round': return [L, R].map(x => el('g', {}, el('circle', { cx: x, cy: top + 4, r: 7.5, fill: c }), el('circle', { cx: x, cy: top + 4, r: 4, fill: a })));
        case 'small': return [L, R].map(x => el('ellipse', { cx: x, cy: top + 4, rx: 5, ry: 7, fill: c }));
        case 'tiny': return [L + 2, R - 2].map(x => el('circle', { cx: x, cy: top + 7, r: 4, fill: shade(c, -0.15) }));
        default: return [];
    }
};
const tailOf = (type, c, a, x, y) => {
    switch (type) {
        case 'long': return el('path', { d: `M${x} ${y} q18 -6 20 -26`, stroke: c, 'stroke-width': 6, fill: 'none', 'stroke-linecap': 'round' });
        case 'thin': return el('path', { d: `M${x} ${y} q12 4 14 -12`, stroke: shade(c, -0.15), 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' });
        case 'short': return el('ellipse', { cx: x + 4, cy: y - 4, rx: 6, ry: 4, fill: c, transform: `rotate(-30 ${x + 4} ${y - 4})` });
        case 'fluffy': return el('ellipse', { cx: x + 10, cy: y - 12, rx: 10, ry: 16, fill: c, transform: `rotate(30 ${x + 10} ${y - 12})`, stroke: a, 'stroke-width': 2 });
        case 'puff': return el('circle', { cx: x + 2, cy: y - 2, r: 7, fill: a });
        case 'ring': return el('g', {}, el('path', { d: `M${x} ${y} q20 -4 20 -28`, stroke: c, 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round' }),
            el('path', { d: `M${x} ${y} q20 -4 20 -28`, stroke: a, 'stroke-width': 9, fill: 'none', 'stroke-dasharray': '4 6', 'stroke-linecap': 'butt', opacity: 0.9 }));
        default: return null;
    }
};
const pattern = (type, c, cx, cy, rx, ry) => {
    const dark = shade(c, -0.28);
    const pts = [[-0.45, -0.2], [0.1, -0.45], [0.45, -0.1], [-0.15, 0.3], [0.35, 0.35], [-0.55, 0.25]];
    switch (type) {
        case 'stripes': return [-0.4, 0, 0.4].map(k => el('path', { d: `M${cx + rx * k - 3} ${cy - ry * 0.9} q4 ${ry * 0.6} 0 ${ry * 1.2}`, stroke: dark, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }));
        case 'spots': case 'dots': return pts.map(([dx, dy]) => el('circle', { cx: cx + dx * rx, cy: cy + dy * ry, r: 2.6, fill: type === 'dots' ? '#fff' : dark, opacity: 0.9 }));
        case 'clouds': return pts.slice(0, 4).map(([dx, dy]) => el('ellipse', { cx: cx + dx * rx, cy: cy + dy * ry, rx: 7, ry: 4.5, fill: 'none', stroke: dark, 'stroke-width': 2.4 }));
        case 'rosettes': return pts.map(([dx, dy]) => el('circle', { cx: cx + dx * rx, cy: cy + dy * ry, r: 3.4, fill: 'none', stroke: '#7d8494', 'stroke-width': 1.8 }));
        case 'patches': return pts.map(([dx, dy]) => el('rect', { x: cx + dx * rx - 4, y: cy + dy * ry - 3.5, width: 8, height: 7, rx: 2.5, fill: '#b86b2a', opacity: 0.85 }));
        case 'scales': return [-0.5, -0.15, 0.2, 0.55].flatMap(k => [-0.3, 0.2].map(j => el('path', { d: `M${cx + k * rx - 6} ${cy + j * ry} q6 -7 12 0`, stroke: dark, 'stroke-width': 2, fill: 'none' })));
        case 'bands': return [-0.35, 0.1].map(k => el('rect', { x: cx + k * rx, y: cy - ry, width: 6, height: ry * 2, fill: '#fff', stroke: INK, 'stroke-width': 1 }));
        default: return [];
    }
};
const star = (x, y, r, fill = '#ffe46b') => el('path', { d: Array.from({ length: 10 }, (_, i) => { const ang = -Math.PI / 2 + i * Math.PI / 5; const rr = i % 2 ? r * 0.45 : r; return `${i ? 'L' : 'M'}${(x + Math.cos(ang) * rr).toFixed(1)} ${(y + Math.sin(ang) * rr).toFixed(1)}`; }).join(' ') + 'Z', fill });

// ------------------------------------------------------------------ 身形
const PLANS = {
    land(o) {
        const neck = !!o.neck; const hx = 60, hy = neck ? 30 : 50, hr = 22;
        const parts = [shadow()];
        parts.push(tailOf(o.tail, o.c, o.a, 86, 82));
        if (o.wings) parts.push(el('path', { d: 'M62 70 q30 -40 50 -30 q-12 6 -14 14 q-10 0 -14 10 q-8 -2 -22 6Z', fill: '#fff', stroke: '#e8c068', 'stroke-width': 1.5 }));
        if (o.fur) parts.push(el('ellipse', { cx: 60, cy: 80, rx: 36, ry: 25, fill: shade(o.c, -0.12) }));
        parts.push(el('ellipse', { cx: 60, cy: 80, rx: 32, ry: 21, fill: o.c }));
        parts.push(...pattern(o.pat, o.c, 60, 78, 28, 15));
        parts.push(el('ellipse', { cx: 60, cy: 88, rx: 18, ry: 10, fill: o.a }));
        [38, 50, 70, 82].forEach(x => parts.push(el('rect', { x: x - 4.5, y: 92, width: 9, height: 14, rx: 4.5, fill: shade(o.c, -0.1) })));
        if (o.vmark) parts.push(el('path', { d: 'M48 74 L60 88 L72 74 L66 74 L60 81 L54 74Z', fill: '#f5f1e6' }));
        if (neck) parts.push(el('rect', { x: 52, y: 38, width: 16, height: 40, rx: 8, fill: o.c }), ...pattern('patches', o.c, 60, 56, 6, 14).slice(0, 3));
        if (o.mane) parts.push(el('path', { d: `M${hx - 14} ${hy - 14} q-10 20 2 34 q-8 -18 12 -30Z`, fill: '#ffb3e6' }), el('path', { d: `M${hx + 18} ${hy - 12} q8 18 -4 30 q4 -18 -6 -28Z`, fill: '#b3e5ff' }));
        parts.push(...ears(o.ears, o.c, o.a, hx, hy, hr));
        if (o.ossicones) [hx - 8, hx + 8].forEach(x => parts.push(el('rect', { x: x - 2, y: hy - hr - 10, width: 4, height: 12, fill: shade(o.c, -0.3) }), el('circle', { cx: x, cy: hy - hr - 10, r: 3.5, fill: shade(o.c, -0.35) })));
        if (o.antlers) [-1, 1].forEach(s => parts.push(el('path', { d: `M${hx + s * 8} ${hy - hr + 4} l${s * 6} -18 m${-s * 3} 8 l${s * 9} -4 m${-s * 7} -9 l${s * 5} -8`, stroke: '#cfd6ff', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' })));
        if (o.stars) parts.push(star(hx - 20, hy - hr - 12, 4.5), star(hx + 21, hy - hr - 16, 4));
        parts.push(el('circle', { cx: hx, cy: hy, r: hr, fill: o.c, stroke: shade(o.c, -0.15), 'stroke-width': 1.2 }));
        if (o.mask) parts.push(el('ellipse', { cx: hx - 9, cy: hy - 1, rx: 7, ry: 6, fill: shade(o.c, -0.3) }), el('ellipse', { cx: hx + 9, cy: hy - 1, rx: 7, ry: 6, fill: shade(o.c, -0.3) }));
        if (o.horn) parts.push(el('path', { d: `M${hx - 4} ${hy - hr + 2} L${hx} ${hy - hr - 20} L${hx + 4} ${hy - hr + 2}Z`, fill: '#c8f4ff', stroke: '#8fdcff', 'stroke-width': 1.2 }));
        if (o.beakFace) parts.push(el('path', { d: `M${hx - 7} ${hy + 4} L${hx} ${hy + 16} L${hx + 7} ${hy + 4}Z`, fill: '#ffb547' }));
        else parts.push(el('ellipse', { cx: hx, cy: hy + 8, rx: o.snout === 'wide' ? 13 : 10, ry: o.snout === 'wide' ? 9 : 7.5, fill: o.a }), el('ellipse', { cx: hx, cy: hy + 5, rx: 3.2, ry: 2.3, fill: INK }));
        parts.push(...eyes(hx - 9, hx + 9, hy - 2), ...blush(hx - 15, hx + 15, hy + 7));
        if (o.smile || !o.beakFace) parts.push(smile(hx - 0.5, hy + 10, 3));
        if (o.trunk) parts.push(el('path', { d: `M${hx} ${hy + 10} q0 18 -10 20`, stroke: o.c, 'stroke-width': 8, fill: 'none', 'stroke-linecap': 'round' }));
        if (o.tusks) [-1, 1].forEach(s => parts.push(el('path', { d: `M${hx + s * 8} ${hy + 12} q${s * 4} 14 ${-s * 6} 18`, stroke: '#f6efe0', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' })));
        if (o.lantern) parts.push(el('line', { x1: 96, y1: 60, x2: 96, y2: 74, stroke: INK, 'stroke-width': 1.5 }), el('rect', { x: 90, y: 74, width: 12, height: 14, rx: 3, fill: '#ffe46b', stroke: '#e0a030' }));
        return parts;
    },
    upright(o) {
        return [shadow(), tailOf(o.tail, o.c, o.a, 74, 100),
            el('ellipse', { cx: 60, cy: 78, rx: 18, ry: 28, fill: o.c }), el('ellipse', { cx: 60, cy: 84, rx: 11, ry: 18, fill: o.a }),
            ...[52, 68].map(x => el('rect', { x: x - 4, y: 98, width: 8, height: 10, rx: 4, fill: shade(o.c, -0.12) })),
            ...[47, 73].map(x => el('ellipse', { cx: x, cy: 70, rx: 4, ry: 9, fill: shade(o.c, -0.08) })),
            el('ellipse', { cx: 60, cy: 40, rx: 17, ry: 15, fill: o.c }), ...ears('tiny', o.c, o.a, 60, 40, 17),
            el('ellipse', { cx: 53, cy: 39, rx: 5.5, ry: 5, fill: shade(o.c, -0.35) }), el('ellipse', { cx: 67, cy: 39, rx: 5.5, ry: 5, fill: shade(o.c, -0.35) }),
            ...eyes(53, 67, 39, 3.4), el('ellipse', { cx: 60, cy: 48, rx: 6, ry: 4, fill: o.a }), el('circle', { cx: 60, cy: 46.5, r: 1.8, fill: INK })];
    },
    bird(o) {
        const big = o.big ? 1.1 : 1, tiny = o.tiny ? 0.78 : 1, k = big * tiny;
        const by = 70, br = 25 * k, hy = 44, hr = (o.owl ? 24 : 17) * k;
        const parts = [shadow()];
        if (o.fire) parts.push(el('path', { d: 'M40 84 q-24 6 -30 -12 q12 6 16 -4 q-10 -10 -6 -24 q8 14 20 14Z', fill: '#ffd23f' }), el('path', { d: 'M42 82 q-16 2 -22 -10 q10 2 12 -6 q-6 -6 -2 -14 q6 10 14 12Z', fill: '#ff6a2b' }));
        if (o.fork) parts.push(el('path', { d: 'M40 80 L16 96 L30 80 L14 84 L38 74Z', fill: o.c }));
        else parts.push(el('path', { d: `M42 78 L${o.wide ? 14 : 22} 88 L40 70Z`, fill: shade(o.c, -0.15) }));
        if (o.legs === 'long') [54, 66].forEach(x => parts.push(el('line', { x1: x, y1: by + br - 2, x2: x, y2: 106, stroke: '#e58a5a', 'stroke-width': 2.6 })));
        else [54, 66].forEach(x => parts.push(el('path', { d: `M${x} ${by + br - 2} l0 8 m-4 0 l8 0`, stroke: '#e58a5a', 'stroke-width': 2.4, 'stroke-linecap': 'round' })));
        const wingW = o.wide ? 38 : 22;
        if (o.membrane) parts.push(el('path', { d: `M44 66 L6 50 L20 74 L10 82 L46 78Z`, fill: shade(o.c, 0.1), stroke: shade(o.c, -0.2) }), el('path', { d: `M76 66 L114 50 L100 74 L110 82 L74 78Z`, fill: shade(o.c, 0.1), stroke: shade(o.c, -0.2) }));
        parts.push(el('circle', { cx: 60, cy: by, r: br, fill: o.c, stroke: shade(o.c, -0.18), 'stroke-width': 1.2 }));
        parts.push(el('ellipse', { cx: 60, cy: by + 6, rx: br * 0.6, ry: br * 0.62, fill: o.a }));
        if (!o.membrane) [-1, 1].forEach(s => parts.push(el('ellipse', { cx: 60 + s * (br - 4), cy: by, rx: wingW * 0.42, ry: 12 * k, fill: shade(o.c, -0.12), transform: `rotate(${s * 25} ${60 + s * (br - 4)} ${by})` })));
        if (o.throat) parts.push(el('ellipse', { cx: 60, cy: hy + hr - 2, rx: 8 * k, ry: 5 * k, fill: o.throat }));
        if (o.pouch) parts.push(el('ellipse', { cx: 60, cy: by + 4, rx: 13, ry: 12, fill: '#e8323c', stroke: '#a3141c' }));
        if (o.crest) parts.push(el('path', { d: `M56 ${hy - hr + 2} q-6 -14 4 -18 q-2 8 6 6 q-4 6 -2 12Z`, fill: o.fire ? '#ffd23f' : shade(o.a, -0.05) }));
        parts.push(el('circle', { cx: 60, cy: hy, r: hr, fill: o.c, stroke: shade(o.c, -0.18), 'stroke-width': 1.2 }));
        if (o.owl) parts.push(el('circle', { cx: 51, cy: hy, r: 9, fill: o.a }), el('circle', { cx: 69, cy: hy, r: 9, fill: o.a }), ...ears('pointy', o.c, o.a, 60, hy + 4, hr));
        parts.push(...eyes(o.owl ? 51 : 53, o.owl ? 69 : 67, hy - 2, o.owl ? 5 : 3.6));
        const bx = 60, bY = hy + 5;
        const beak = {
            small: `M${bx - 4} ${bY} L${bx} ${bY + 7} L${bx + 4} ${bY}Z`, hook: `M${bx - 5} ${bY - 1} q5 -3 10 0 q-1 8 -6 10 q2 -6 -4 -10Z`,
            long: `M${bx - 3} ${bY} L${bx + 26} ${bY + 4} L${bx - 3} ${bY + 6}Z`, needle: `M${bx - 2} ${bY} L${bx + 28} ${bY + 2} L${bx - 2} ${bY + 4}Z`,
            bent: `M${bx - 4} ${bY} q16 0 18 10 q-2 4 -6 2 q-2 -6 -12 -6Z`, toucan: `M${bx - 4} ${bY - 4} q22 -2 28 8 q-10 10 -28 4Z`,
        }[o.beak || 'small'];
        parts.push(el('path', { d: beak, fill: o.beak === 'toucan' ? '#ff9f1c' : (o.fire ? '#ffd23f' : '#f2a33a'), stroke: shade('#f2a33a', -0.25), 'stroke-width': 0.8 }));
        parts.push(...blush(49, 71, hy + 7));
        return parts;
    },
    fish(o) {
        const rx = o.big ? 40 : (o.round ? 26 : 32), ry = o.round ? 26 : 20;
        const parts = [shadow(),
            el('path', { d: `M${60 - rx + 4} 64 L${60 - rx - 18} 48 L${60 - rx - 14} 64 L${60 - rx - 18} 80Z`, fill: shade(o.c, -0.12) }),
            el('path', { d: `M52 ${64 - ry + 2} q8 -14 18 -2Z`, fill: shade(o.c, -0.12) }),
            el('ellipse', { cx: 60, cy: 64, rx, ry, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            el('ellipse', { cx: 62, cy: 72, rx: rx * 0.6, ry: ry * 0.45, fill: o.a, opacity: 0.85 })];
        parts.push(...pattern(o.pat, o.c, 60, 64, rx, ry));
        if (o.spikes) for (let i = 0; i < 10; i++) { const ang = i / 10 * Math.PI * 2; parts.push(el('line', { x1: 60 + Math.cos(ang) * rx, y1: 64 + Math.sin(ang) * ry, x2: 60 + Math.cos(ang) * (rx + 6), y2: 64 + Math.sin(ang) * (ry + 6), stroke: shade(o.c, -0.3), 'stroke-width': 2 })); }
        parts.push(...eyes(60 + rx * 0.45, 60 + rx * 0.45 + 0.01, 58, 4).slice(0, 1), smile(60 + rx * 0.62, 68, 3), ...blush(60 + rx * 0.3, 60 + rx * 0.3, 68).slice(0, 1));
        return parts;
    },
    whale(o) {
        const parts = [shadow(),
            el('path', { d: 'M24 62 L6 46 q4 14 2 18 q2 4 -2 18 L24 70Z', fill: shade(o.c, -0.1) }),
            el('path', { d: 'M20 66 q10 -36 52 -36 q38 0 40 34 q0 28 -46 28 q-38 0 -46 -26Z', fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            el('path', { d: 'M40 80 q30 14 66 -4 q-6 14 -40 16 q-20 0 -26 -12Z', fill: o.a })];
        if (o.orca) parts.push(el('ellipse', { cx: 88, cy: 52, rx: 8, ry: 5, fill: '#fff' }), el('path', { d: 'M58 30 l6 -18 l8 18Z', fill: o.c }));
        if (o.reptile) parts.push(...[48, 80].map(x => el('ellipse', { cx: x, cy: 88, rx: 10, ry: 4, fill: shade(o.c, -0.15), transform: `rotate(20 ${x} 88)` })), el('path', { d: 'M92 70 l3 4 l3 -4 l3 4 l3 -4', stroke: '#fff', 'stroke-width': 1.5, fill: 'none' }));
        if (o.cloud) parts.push(...[[44, 34, 12], [62, 28, 14], [82, 32, 12]].map(([x, y, r]) => el('circle', { cx: x, cy: y, r, fill: '#fff' })), ...[50, 64, 78].map(x => el('line', { x1: x, y1: 98, x2: x - 3, y2: 108, stroke: '#9cc7ff', 'stroke-width': 2, 'stroke-linecap': 'round' })));
        parts.push(...eyes(84, 84.01, 60, 3.8).slice(0, 1), smile(94, 70, 4), ...blush(82, 82, 70).slice(0, 1));
        return parts;
    },
    star(o) {
        const pts = Array.from({ length: 10 }, (_, i) => { const ang = -Math.PI / 2 + i * Math.PI / 5; const r = i % 2 ? 18 : 42; return `${(60 + Math.cos(ang) * r).toFixed(1)},${(64 + Math.sin(ang) * r).toFixed(1)}`; }).join(' ');
        return [shadow(), el('polygon', { points: pts, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 2, 'stroke-linejoin': 'round' }),
            ...[[60, 40], [40, 60], [80, 60], [48, 84], [72, 84]].map(([x, y]) => el('circle', { cx: x, cy: y, r: 2, fill: o.a })), ...eyes(53, 67, 62, 3.6), smile(60, 70, 3)];
    },
    crab(o) {
        return [shadow(), o.shell ? el('g', {}, el('circle', { cx: 74, cy: 60, r: 24, fill: '#f6d7b0', stroke: '#c79a6b', 'stroke-width': 2 }), el('path', { d: 'M74 60 m-12 0 a12 12 0 1 1 12 12 a8 8 0 1 1 -8 -8', fill: 'none', stroke: '#c79a6b', 'stroke-width': 2 })) : null,
            el('ellipse', { cx: 54, cy: 80, rx: 22, ry: 15, fill: o.c }),
            ...[-1, 1].map(s => el('g', {}, el('circle', { cx: 54 + s * 26, cy: 70, r: 9, fill: o.c }), el('path', { d: `M${54 + s * 26} 70 l${s * 6} -6`, stroke: '#fff', 'stroke-width': 2 }))),
            ...[40, 48, 60, 68].map(x => el('line', { x1: x, y1: 92, x2: x + (x < 54 ? -6 : 6), y2: 104, stroke: o.c, 'stroke-width': 3, 'stroke-linecap': 'round' })),
            ...[46, 62].map(x => el('line', { x1: x, y1: 70, x2: x, y2: 60, stroke: o.c, 'stroke-width': 2.4 })), ...eyes(46, 62, 58, 3.4), smile(54, 84, 3)];
    },
    seahorse(o) {
        return [shadow(), el('path', { d: 'M60 30 q22 4 18 26 q-4 18 -16 24 q-12 8 -6 18 q6 8 12 2 q4 -4 0 -8', stroke: o.c, 'stroke-width': 16, fill: 'none', 'stroke-linecap': 'round' }),
            el('path', { d: 'M60 30 q22 4 18 26 q-4 18 -16 24', stroke: o.a, 'stroke-width': 5, fill: 'none', 'stroke-dasharray': '3 5' }),
            el('path', { d: 'M54 30 L36 34 L54 40Z', fill: o.c }), el('path', { d: 'M74 50 q12 -2 10 12 q-6 -4 -10 -2Z', fill: o.a }),
            el('path', { d: 'M58 22 l4 -8 l4 8', fill: o.c }), ...eyes(62, 62.01, 32, 3.4).slice(0, 1)];
    },
    jelly(o) {
        const parts = [el('ellipse', { cx: 60, cy: 110, rx: 22, ry: 4, fill: '#000', opacity: 0.12 }),
            ...[42, 52, 62, 72, 80].map((x, i) => el('path', { d: `M${x} 66 q${i % 2 ? 6 : -6} 12 0 22 q${i % 2 ? -6 : 6} 10 0 18`, stroke: o.a, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', opacity: 0.9 })),
            el('path', { d: 'M30 66 q0 -38 30 -38 q30 0 30 38 q-8 6 -15 0 q-8 6 -15 0 q-8 6 -15 0 q-8 6 -15 0Z', fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2, opacity: 0.95 }),
            el('ellipse', { cx: 50, cy: 42, rx: 8, ry: 5, fill: '#fff', opacity: 0.55 })];
        if (o.metal) parts.push(...[38, 60, 82].map(x => el('circle', { cx: x, cy: 60, r: 2.2, fill: '#5b6b7d' })), el('rect', { x: 52, y: 22, width: 16, height: 6, rx: 2, fill: '#5b6b7d' }));
        parts.push(...eyes(52, 68, 52, 3.6), smile(60, 58, 3), ...blush(45, 75, 58));
        return parts;
    },
    turtle(o) {
        const parts = [shadow(), ...[[34, 96], [86, 96], [30, 72], [90, 72]].map(([x, y]) => el('ellipse', { cx: x, cy: y, rx: 10, ry: 6, fill: o.c })),
            el('circle', { cx: 98, cy: 70, r: 13, fill: o.c }),
            el('path', { d: 'M26 88 q0 -44 34 -44 q34 0 34 44Z', fill: shade(o.c, -0.18), stroke: shade(o.c, -0.35), 'stroke-width': 1.5 }),
            ...[[48, 66], [60, 58], [72, 66], [54, 78], [66, 78]].map(([x, y]) => el('polygon', { points: `${x - 7},${y} ${x - 3},${y - 6} ${x + 3},${y - 6} ${x + 7},${y} ${x + 3},${y + 6} ${x - 3},${y + 6}`, fill: o.a, opacity: 0.6 }))];
        if (o.crystals) parts.push(...[[46, 50], [60, 40], [74, 50]].map(([x, y], i) => el('polygon', { points: `${x},${y - 12} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`, fill: ['#b3e5ff', '#ffc8f0', '#d6ffb3'][i], stroke: '#fff', 'stroke-width': 1 })));
        parts.push(...eyes(95, 104, 67, 3), smile(100, 74, 2.5));
        return parts;
    },
    octopus(o) {
        return [shadow(), ...Array.from({ length: 8 }, (_, i) => { const x = 30 + i * 8.5; return el('path', { d: `M${x} 72 q${i < 4 ? -10 : 10} 18 ${i < 4 ? -2 : 2} 30 q4 2 6 -2`, stroke: o.c, 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round' }); }),
            el('ellipse', { cx: 60, cy: 52, rx: 30, ry: 28, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            ...[[48, 38], [72, 34], [62, 26]].map(([x, y]) => el('circle', { cx: x, cy: y, r: 3, fill: o.a })), ...eyes(50, 70, 56, 4.2), smile(60, 66, 4), ...blush(42, 78, 64)];
    },
    ray(o) {
        return [shadow(), el('path', { d: 'M60 104 q4 6 2 14', stroke: o.c, 'stroke-width': 3, fill: 'none' }),
            el('path', { d: 'M60 34 Q96 50 114 72 Q84 82 60 100 Q36 82 6 72 Q24 50 60 34Z', fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            el('ellipse', { cx: 60, cy: 74, rx: 16, ry: 12, fill: o.a, opacity: 0.7 }), ...eyes(52, 68, 60, 3.6), smile(60, 70, 3), ...blush(46, 74, 68)];
    },
    robot(o) {
        const parts = [shadow()];
        if (o.tail) parts.push(el('path', { d: 'M86 82 q16 -4 18 -20', stroke: o.c, 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round' }));
        if (o.legs === 4) [40, 52, 68, 80].forEach(x => parts.push(el('rect', { x: x - 3.5, y: 88, width: 7, height: 18, rx: 2, fill: shade(o.c, -0.25) }), el('circle', { cx: x, cy: 96, r: 3, fill: o.a })));
        if (o.wheels) [40, 80].forEach(x => parts.push(el('circle', { cx: x, cy: 98, r: 9, fill: '#3a4556' }), el('circle', { cx: x, cy: 98, r: 3.5, fill: o.a })));
        if (o.mech) [48, 72].forEach(x => parts.push(el('rect', { x: x - 6, y: 88, width: 12, height: 20, rx: 3, fill: shade(o.c, -0.2) })));
        parts.push(el('rect', { x: o.car ? 22 : 32, y: 64, width: o.car ? 76 : 56, height: 28, rx: 10, fill: o.c, stroke: shade(o.c, -0.25), 'stroke-width': 1.5 }));
        if (o.spots) parts.push(...pattern('spots', '#c9a227', 60, 78, 24, 10));
        if (o.panel) parts.push(el('rect', { x: 26, y: 50, width: 68, height: 10, fill: o.a, stroke: '#1d3f80' }), el('line', { x1: 60, y1: 60, x2: 60, y2: 64, stroke: '#5b6b7d', 'stroke-width': 3 }));
        if (o.arms) [-1, 1].forEach(s => parts.push(el('path', { d: `M${60 + s * 28} 72 l${s * 12} 8 l${s * 2} 10`, stroke: shade(o.c, -0.25), 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' })));
        if (o.drill) parts.push(el('path', { d: 'M88 76 L110 82 L88 88Z', fill: '#c0c7d2', stroke: '#6b7686' }));
        if (o.props) [[30, 40], [90, 40]].forEach(([x, y]) => parts.push(el('line', { x1: x, y1: y + 10, x2: x + (x < 60 ? 10 : -10), y2: 64, stroke: '#5b6b7d', 'stroke-width': 3 }), el('ellipse', { cx: x, cy: y + 6, rx: 14, ry: 3, fill: o.a, opacity: 0.8 })));
        parts.push(el('rect', { x: 38, y: 26, width: 44, height: 36, rx: 12, fill: o.c, stroke: shade(o.c, -0.25), 'stroke-width': 1.5 }));
        if (o.ears === 'pointy' || o.ears === 'cat') [44, 76].forEach((x, i) => parts.push(el('path', { d: `M${x - 6} 30 L${x + (i ? 4 : -4)} 14 L${x + 6} 30Z`, fill: shade(o.c, -0.1) })));
        if (o.ears === 'round') [42, 78].forEach(x => parts.push(el('circle', { cx: x, cy: 28, r: 6, fill: shade(o.c, -0.1) })));
        parts.push(el('line', { x1: 60, y1: 26, x2: 60, y2: 14, stroke: '#5b6b7d', 'stroke-width': 2.5 }), el('circle', { cx: 60, cy: 12, r: 4, fill: o.a }));
        parts.push(el('rect', { x: 44, y: 34, width: 32, height: 20, rx: 6, fill: '#14203a' }),
            ...[52, 68].map(x => el('rect', { x: x - 3.5, y: 39, width: 7, height: 9, rx: 3, fill: o.a })), smile(60, 50, 3));
        return parts;
    },
    dragon(o) {
        const k = o.big ? 1.08 : (o.small ? 0.85 : 1);
        const parts = [shadow(), el('path', { d: 'M84 88 q22 2 26 -18 l6 6 l-2 -10', stroke: o.c, 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round' }),
            ...[-1, 1].map(s => el('path', { d: `M${60 + s * 14} 70 L${60 + s * 48 * k} ${44 - 6 * k} L${60 + s * 40 * k} 62 L${60 + s * 46 * k} 74 L${60 + s * 20} 80Z`, fill: shade(o.c, 0.15), stroke: shade(o.c, -0.2), 'stroke-width': 1.2 })),
            el('ellipse', { cx: 60, cy: 82, rx: 24 * k, ry: 19 * k, fill: o.c }), el('ellipse', { cx: 60, cy: 88, rx: 14 * k, ry: 11 * k, fill: o.a, opacity: 0.85 }),
            ...[48, 72].map(x => el('rect', { x: x - 5, y: 94, width: 10, height: 12, rx: 5, fill: shade(o.c, -0.12) })),
            ...[50, 70].map((x, i) => el('path', { d: `M${x} 34 l${i ? 6 : -6} -16 l${i ? -1 : 1} 18Z`, fill: o.a })),
            el('ellipse', { cx: 60, cy: 48, rx: 22 * k, ry: 19 * k, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            el('ellipse', { cx: 60, cy: 56, rx: 11, ry: 7, fill: o.a, opacity: 0.8 })];
        if (o.metal) parts.push(...[44, 76].map(x => el('circle', { cx: x, cy: 46, r: 2, fill: '#5b6b7d' })), el('rect', { x: 50, y: 70, width: 20, height: 6, rx: 2, fill: o.a }));
        parts.push(...eyes(52, 68, 46, 4), smile(60, 58, 3), ...blush(45, 75, 54));
        if (o.big) parts.push(star(60, 26, 5, '#ffd23f'));
        return parts;
    },
    trilobite(o) {
        return [shadow(), el('ellipse', { cx: 60, cy: 68, rx: 30, ry: 36, fill: o.c, stroke: shade(o.c, -0.25), 'stroke-width': 1.5 }),
            ...Array.from({ length: 6 }, (_, i) => el('path', { d: `M34 ${56 + i * 8} q26 6 52 0`, stroke: shade(o.c, -0.25), 'stroke-width': 2, fill: 'none' })),
            el('rect', { x: 54, y: 40, width: 12, height: 60, rx: 6, fill: o.a, opacity: 0.8 }), el('path', { d: 'M30 44 q30 -22 60 0', stroke: shade(o.c, -0.2), 'stroke-width': 3, fill: 'none' }),
            ...eyes(48, 72, 42, 3.4), smile(60, 50, 3)];
    },
    ammonite(o) {
        return [shadow(), el('circle', { cx: 60, cy: 64, r: 34, fill: o.c, stroke: shade(o.c, -0.25), 'stroke-width': 2 }),
            el('path', { d: 'M60 64 m-6 0 a6 6 0 1 1 6 6 a12 12 0 1 1 -12 -12 a18 18 0 1 1 18 18 a24 24 0 1 1 -24 -24', stroke: shade(o.c, -0.3), 'stroke-width': 2.4, fill: 'none' }),
            ...Array.from({ length: 10 }, (_, i) => { const a = i / 10 * Math.PI * 2; return el('line', { x1: 60 + Math.cos(a) * 26, y1: 64 + Math.sin(a) * 26, x2: 60 + Math.cos(a) * 34, y2: 64 + Math.sin(a) * 34, stroke: o.a, 'stroke-width': 2 }); }),
            el('path', { d: 'M88 80 q14 6 18 20', stroke: '#e8a0b4', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }), ...eyes(84, 84.01, 78, 3.2).slice(0, 1)];
    },
    dino(o) {
        const k = o.big ? 1.1 : 1; const parts = [shadow()];
        parts.push(el('path', { d: `M38 80 Q14 84 6 ${o.biped ? 70 : 92}`, stroke: o.c, 'stroke-width': 12, fill: 'none', 'stroke-linecap': 'round' }));
        if (o.club) parts.push(el('circle', { cx: 8, cy: 90, r: 8, fill: shade(o.c, -0.25) }));
        if (o.spikes) parts.push(...[[10, 84], [16, 88]].map(([x, y]) => el('path', { d: `M${x} ${y} l-4 -10 l8 4Z`, fill: o.a })));
        if (o.plates) parts.push(...[34, 46, 58, 70].map((x, i) => el('path', { d: `M${x - 7} ${62 - (i === 1 || i === 2 ? 4 : 0)} L${x} ${46 - (i === 1 || i === 2 ? 8 : 0)} L${x + 7} ${62}Z`, fill: '#e0874a' })));
        parts.push(el('ellipse', { cx: 56, cy: 78, rx: 30 * k, ry: 20 * k, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }));
        if (o.armor) parts.push(...pattern('scales', o.c, 56, 74, 26, 14), ...[30, 44, 58, 72].map(x => el('path', { d: `M${x} 60 l3 -8 l3 8Z`, fill: o.a })));
        if (o.feathers) parts.push(el('path', { d: 'M30 72 q-6 -10 2 -16 q2 8 8 8Z', fill: o.a }), el('path', { d: 'M40 64 q-2 -10 6 -14 q0 8 6 10Z', fill: o.a }));
        parts.push(el('ellipse', { cx: 58, cy: 86, rx: 16, ry: 9, fill: o.a, opacity: 0.85 }));
        (o.biped ? [48, 66] : [36, 48, 64, 76]).forEach(x => parts.push(el('rect', { x: x - 5, y: 90, width: 10, height: 16, rx: 5, fill: shade(o.c, -0.12) })));
        const hx = o.longneck ? 92 : 84, hy = o.longneck ? 28 : (o.biped ? 50 : 62);
        if (o.longneck) parts.push(el('path', { d: 'M74 72 Q90 56 92 36', stroke: o.c, 'stroke-width': 14, fill: 'none', 'stroke-linecap': 'round' }));
        else if (o.biped) parts.push(el('path', { d: 'M74 70 Q82 62 84 54', stroke: o.c, 'stroke-width': 14, fill: 'none', 'stroke-linecap': 'round' }), el('path', { d: 'M72 76 l8 4', stroke: shade(o.c, -0.15), 'stroke-width': 4, 'stroke-linecap': 'round' }));
        if (o.frill) parts.push(el('ellipse', { cx: hx - 10, cy: hy - 4, rx: 14, ry: 18, fill: o.a, stroke: shade(o.c, -0.2) }));
        if (o.crest) parts.push(el('path', { d: `M${hx - 6} ${hy - 10} Q${hx - 30} ${hy - 28} ${hx - 34} ${hy - 22} Q${hx - 22} ${hy - 12} ${hx - 2} ${hy - 6}Z`, fill: o.a, stroke: shade(o.c, -0.2) }));
        parts.push(el('ellipse', { cx: hx, cy: hy, rx: 16 * k, ry: 13 * k, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }));
        if (o.horns) parts.push(...[[hx + 2, hy - 12, -2], [hx + 10, hy - 10, 6], [hx + 14, hy + 2, 10]].map(([x, y, d]) => el('path', { d: `M${x - 3} ${y} L${x + d * 0.6} ${y - 12} L${x + 3} ${y}Z`, fill: '#f6efe0' })));
        parts.push(...eyes(hx - 3, hx + 7, hy - 2, 3.2), smile(hx + 6, hy + 6, 3), ...blush(hx - 6, hx + 11, hy + 5));
        return parts;
    },
    sprite(o) {
        return [shadow(), ...[44, 76].map(x => el('ellipse', { cx: x, cy: 82, rx: 6, ry: 4, fill: shade(o.c, -0.1) })),
            el('path', { d: 'M30 92 q-2 -50 30 -52 q32 2 30 52 q-30 10 -60 0Z', fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            ...[[40, 70], [76, 62], [58, 84]].map(([x, y]) => el('circle', { cx: x, cy: y, r: 3.5, fill: o.a, opacity: 0.8 })),
            el('path', { d: 'M60 40 q-4 -18 12 -22 q-2 14 -12 22Z', fill: '#3fa34d' }), el('path', { d: 'M60 40 q-2 -12 -14 -14 q2 10 14 14Z', fill: '#58c46a' }),
            ...eyes(51, 69, 62, 4.2), smile(60, 72, 4), ...blush(43, 77, 70)];
    },
    serpent(o) {
        return [shadow(), el('path', { d: 'M14 96 Q34 70 54 92 T94 84 Q104 60 88 46', stroke: o.c, 'stroke-width': 18, fill: 'none', 'stroke-linecap': 'round' }),
            el('path', { d: 'M14 96 Q34 70 54 92 T94 84 Q104 60 88 46', stroke: o.a, 'stroke-width': 5, fill: 'none', 'stroke-dasharray': '2 7', 'stroke-linecap': 'round' }),
            el('ellipse', { cx: 84, cy: 40, rx: 17, ry: 14, fill: o.c, stroke: shade(o.c, -0.2), 'stroke-width': 1.2 }),
            el('path', { d: 'M96 44 q12 -2 16 6 M96 48 q10 4 12 12', stroke: '#ffd23f', 'stroke-width': 2, fill: 'none' }),
            el('path', { d: 'M76 26 l-2 -10 l6 8 M88 26 l2 -10 l-6 8', stroke: '#ffd23f', 'stroke-width': 3, fill: 'none' }),
            ...eyes(79, 91, 38, 3.4), smile(85, 46, 3)];
    },
};

/**
 * 產生角色 SVG。
 *  silhouette：未解鎖時的剪影（沒有細節、只有輪廓與問號）
 *  stage：成長階段 0–3（大小隨成長變化；3 有完成星章）
 */
export const creatureSVG = (item, { size = 96, silhouette = false, stage = 3, label = null } = {}) => {
    const o = item.art || {};
    const plan = PLANS[o.p] || PLANS.land;
    const scale = [0.74, 0.84, 0.94, 1][Math.max(0, Math.min(3, stage))];
    const g = el('g', { transform: `translate(${60 - 60 * scale} ${112 - 112 * scale}) scale(${scale})` }, ...plan(o).filter(Boolean));
    const svg = el('svg', { viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-label': label || (silhouette ? '尚未解鎖的收藏' : item.name), class: 'creature' + (silhouette ? ' silhouette' : '') }, g);
    if (silhouette) {
        g.querySelectorAll('*').forEach(n => { if (n.getAttribute('fill') && n.getAttribute('fill') !== 'none') n.setAttribute('fill', '#0b1530'); if (n.getAttribute('stroke')) n.setAttribute('stroke', '#0b1530'); });
        svg.append(el('text', { x: 60, y: 74, 'text-anchor': 'middle', 'font-size': 34, 'font-weight': 800, fill: '#7fa8c9' }, '？'));
    } else if (stage >= 3) svg.append(star(104, 16, 9, '#ffd23f'));
    return svg;
};
