// 園區環境動態（程式繪製，CSS 動畫）：讓場景「活起來」，也讓 AI 背景板不像一張靜止的照片。
// back：放在背景與角色之間（遠景）；front：放在角色前面（近景，不擋點擊）。
import { h } from '../ui/dom.js';

// 固定的偽亂數，每次畫面一樣（測試截圖穩定）
const rand = (seed) => () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
const many = (n, seed, make) => { const r = rand(seed); return Array.from({ length: n }, (_, i) => make(r, i)); };
const fx = (cls, vars, ...kids) => h('span', { class: `amb ${cls}`, 'aria-hidden': 'true', style: Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';') }, ...kids);

const clouds = (n, seed, top = [4, 30]) => many(n, seed, (r, i) => fx('amb-cloud', { y: `${top[0] + r() * (top[1] - top[0])}%`, s: (0.6 + r() * 0.8).toFixed(2), d: `${70 + r() * 60}s`, o: `${-r() * 100}s`, a: (0.55 + r() * 0.35).toFixed(2), i }));
const floaters = (cls, n, seed, { y = [10, 90], d = [6, 14] } = {}) => many(n, seed, (r) => fx(cls, { x: `${r() * 100}%`, y: `${y[0] + r() * (y[1] - y[0])}%`, d: `${d[0] + r() * (d[1] - d[0])}s`, o: `${-r() * 20}s`, s: (0.6 + r() * 0.8).toFixed(2) }));

const WORLD = {
    land: () => ({
        back: [fx('amb-sunglow', {}), ...clouds(4, 3)],
        front: [...floaters('amb-butterfly', 4, 7, { y: [45, 85], d: [9, 15] }), ...floaters('amb-leaf', 4, 11, { y: [0, 10], d: [10, 16] })],
    }),
    ocean: () => ({
        back: [...many(5, 5, (r, i) => fx('amb-ray', { x: `${8 + i * 20 + r() * 8}%`, d: `${6 + r() * 5}s`, o: `${-r() * 6}s`, w: `${6 + r() * 8}%` })),
            fx('amb-school', { y: '30%', d: '38s', o: '-12s' }, ...many(7, 9, (r, i) => h('i', { style: `--k:${i};--r:${r().toFixed(2)}` }))), fx('amb-caustic', {})],
        front: floaters('amb-bubble', 14, 13, { y: [60, 100], d: [6, 12] }),
    }),
    sky: () => ({
        back: [fx('amb-sunglow', { c: '#fff3b0' }), ...clouds(5, 17, [8, 60])],
        front: [...floaters('amb-wind', 4, 19, { y: [15, 70], d: [5, 9] }), ...clouds(2, 23, [62, 80]).map(n => { n.classList.add('amb-near'); return n; })],
    }),
    tech: () => ({
        back: [fx('amb-scan', {}), ...floaters('amb-pixel', 12, 29, { y: [20, 95], d: [7, 13] })],
        front: [fx('amb-flicker', {})],
    }),
    prehistoric: () => ({
        back: [fx('amb-sunglow', { c: '#ffd29a' }), fx('amb-flyer', { y: '16%', d: '46s', o: '-20s' }), fx('amb-flyer', { y: '24%', d: '58s', o: '-41s', s: 0.7 })],
        front: floaters('amb-dust', 12, 31, { y: [40, 95], d: [8, 14] }),
    }),
    fantasy: () => ({
        back: [fx('amb-aurora', {}), ...floaters('amb-star', 14, 37, { y: [2, 40], d: [2, 5] })],
        front: floaters('amb-firefly', 16, 41, { y: [35, 95], d: [7, 13] }),
    }),
};

/** 回傳 { back: Node, front: Node }：兩個覆蓋整個舞台的圖層 */
export const ambientLayers = (world) => {
    const { back, front } = (WORLD[world] || WORLD.land)();
    return {
        back: h('div', { class: `amb-layer amb-back amb-${world}`, 'aria-hidden': 'true' }, back),
        front: h('div', { class: `amb-layer amb-front amb-${world}`, 'aria-hidden': 'true' }, front, h('span', { class: 'amb-vignette' })),
    };
};
