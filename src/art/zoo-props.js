// 園區前景／中景道具（原創 SVG）。道具和角色一樣有深度 z，角色可以走到道具後面。
import { s } from '../ui/dom.js';

const view = (kids, w = 100, h = 100) => s('svg', { viewBox: `0 0 ${w} ${h}`, class: 'zoo-prop-svg', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMax meet' }, ...kids);

const BUILD = {
    bush: (c = '#4caf50') => view([s('ellipse', { cx: 50, cy: 96, rx: 44, ry: 4, fill: '#000', opacity: 0.15 }),
        s('circle', { cx: 30, cy: 70, r: 26, fill: c }), s('circle', { cx: 70, cy: 70, r: 26, fill: c }), s('circle', { cx: 50, cy: 52, r: 30, fill: c }),
        s('circle', { cx: 42, cy: 44, r: 10, fill: '#fff', opacity: 0.18 })]),
    rock: (c = '#9aa3ad') => view([s('ellipse', { cx: 50, cy: 96, rx: 42, ry: 4, fill: '#000', opacity: 0.18 }),
        s('path', { d: 'M8 96 Q14 52 44 46 Q80 40 92 96Z', fill: c }), s('path', { d: 'M30 60 Q48 50 64 56', stroke: '#fff', 'stroke-width': 4, opacity: 0.25, fill: 'none', 'stroke-linecap': 'round' })]),
    flowers: () => view([...[[22, '#ff7aa2'], [50, '#ffd23f'], [76, '#b06cff']].map(([x, c]) => s('g', {},
        s('path', { d: `M${x} 98 q-2 -20 0 -40`, stroke: '#3f8f3a', 'stroke-width': 4, fill: 'none' }),
        ...[0, 72, 144, 216, 288].map(a => s('ellipse', { cx: x, cy: 50, rx: 6, ry: 10, fill: c, transform: `rotate(${a} ${x} 58) translate(0 -2)` })),
        s('circle', { cx: x, cy: 58, r: 5, fill: '#fff3b0' })))]),
    tree: () => view([s('ellipse', { cx: 50, cy: 98, rx: 30, ry: 2.5, fill: '#000', opacity: 0.15 }), s('rect', { x: 44, y: 50, width: 12, height: 48, rx: 4, fill: '#7a5232' }),
        s('circle', { cx: 50, cy: 34, r: 30, fill: '#3f9a4a' }), s('circle', { cx: 28, cy: 48, r: 18, fill: '#3f9a4a' }), s('circle', { cx: 72, cy: 48, r: 18, fill: '#358a40' })]),
    seaweed: (c = '#3fbf7f') => view([...[30, 50, 70].map((x, i) => s('path', { class: 'zoo-sway', style: `--d:${i * 0.4}s`, d: `M${x} 100 q-12 -20 0 -40 q12 -20 0 -45`, stroke: c, 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round' }))]),
    coral: (c = '#ff7a8a') => view([s('path', { d: 'M50 100 V60 M50 74 Q30 64 28 40 M50 68 Q70 58 74 34 M28 50 Q16 44 16 30 M74 46 Q86 40 86 26', stroke: c, 'stroke-width': 10, fill: 'none', 'stroke-linecap': 'round' })]),
    cloud: () => view([s('ellipse', { cx: 50, cy: 74, rx: 46, ry: 20, fill: '#fff' }), s('circle', { cx: 34, cy: 60, r: 20, fill: '#fff' }), s('circle', { cx: 62, cy: 54, r: 26, fill: '#fff' }),
        s('ellipse', { cx: 50, cy: 86, rx: 40, ry: 8, fill: '#dbe9ff' })]),
    crate: () => view([s('ellipse', { cx: 50, cy: 97, rx: 40, ry: 3, fill: '#000', opacity: 0.3 }), s('rect', { x: 14, y: 40, width: 72, height: 56, rx: 4, fill: '#2e4677', stroke: '#00e5ff', 'stroke-width': 2 }),
        s('path', { d: 'M14 40 L86 96 M86 40 L14 96', stroke: '#00e5ff', 'stroke-width': 2, opacity: 0.5 })]),
    neon: () => view([s('rect', { x: 46, y: 10, width: 8, height: 88, fill: '#22345f' }), s('rect', { class: 'zoo-blink', x: 40, y: 10, width: 20, height: 10, rx: 4, fill: '#00e5ff' })]),
    fern: () => view([...[-50, -25, 0, 25, 50].map(a => s('path', { d: `M50 100 q${a * 0.5} -40 ${a} -70`, stroke: '#4f7a3a', 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round' }))]),
    bones: () => view([s('path', { d: 'M20 90 Q50 60 80 90', stroke: '#efe6d2', 'stroke-width': 8, fill: 'none', 'stroke-linecap': 'round' }),
        ...[30, 42, 54, 66].map(x => s('path', { d: `M${x} ${78 - Math.abs(x - 48) * 0.3} v14`, stroke: '#efe6d2', 'stroke-width': 5, 'stroke-linecap': 'round' }))]),
    mushroom: (c = '#7ef9ff') => view([s('rect', { x: 44, y: 56, width: 12, height: 42, rx: 5, fill: '#efe6ff' }), s('path', { d: 'M18 60 Q50 10 82 60Z', fill: c, class: 'zoo-glow' }),
        ...[[38, 44], [56, 36], [66, 50]].map(([x, y]) => s('circle', { cx: x, cy: y, r: 4, fill: '#fff', opacity: 0.8 }))]),
    crystal: (c = '#c79bff') => view([s('path', { d: 'M50 100 L36 50 L50 14 L64 50Z', fill: c, opacity: 0.9, class: 'zoo-glow' }), s('path', { d: 'M30 100 L22 70 L32 52 L40 72Z', fill: c, opacity: 0.7 }),
        s('path', { d: 'M50 14 L50 100', stroke: '#fff', opacity: 0.4, 'stroke-width': 2 })]),
};

/**
 * 每個世界的道具配置：[AI 道具 ID（assets/creatures/<id>.webp）, SVG 備用種類（null＝沒有 AI 圖就不放）, x, z, 高度比例, SVG 顏色?]
 * 有核准的 AI 道具圖就用圖片，否則用 SVG。
 */
const LAYOUT = {
    land: [['land-tree', 'tree', 0.06, 0.05, 0.42], ['land-tree', 'tree', 0.93, 0.15, 0.48], ['land-bush', 'bush', 0.22, 0.55, 0.13], ['land-rock', 'rock', 0.7, 0.4, 0.1],
        ['land-grass', 'flowers', 0.47, 0.85, 0.1], ['land-bush', 'bush', 0.9, 0.95, 0.16], ['land-sign', null, 0.36, 0.08, 0.14]],
    ocean: [['ocean-kelp', 'seaweed', 0.08, 0.3, 0.32], ['ocean-coral', 'coral', 0.3, 0.7, 0.16], ['ocean-rock', 'rock', 0.62, 0.5, 0.1, '#7d8ea3'], ['ocean-kelp', 'seaweed', 0.85, 0.9, 0.36, '#2fa36a'],
        ['ocean-coral', 'coral', 0.95, 0.4, 0.14, '#ffb347'], ['ocean-anchor', null, 0.5, 0.15, 0.1], ['ocean-seagrass', null, 0.18, 0.95, 0.08]],
    sky: [['sky-cloud', 'cloud', 0.12, 0.95, 0.16], ['sky-cloud2', 'cloud', 0.6, 0.6, 0.12], ['sky-cloud', 'cloud', 0.88, 0.85, 0.15], ['sky-island', null, 0.3, 0.1, 0.2], ['sky-balloon', null, 0.8, 0.2, 0.22]],
    tech: [['tech-lamp', 'neon', 0.05, 0.3, 0.32], ['tech-crates', 'crate', 0.3, 0.75, 0.12], ['tech-crates', 'crate', 0.74, 0.45, 0.1], ['tech-lamp', 'neon', 0.95, 0.85, 0.38],
        ['tech-charger', null, 0.55, 0.2, 0.1], ['tech-holo', null, 0.18, 0.15, 0.2], ['tech-antenna', null, 0.86, 0.05, 0.26]],
    prehistoric: [['pre-fern', 'fern', 0.06, 0.6, 0.24], ['pre-boulder', 'rock', 0.4, 0.35, 0.1, '#a58a6a'], ['pre-fossil', 'bones', 0.62, 0.8, 0.08], ['pre-fern', 'fern', 0.93, 0.9, 0.28],
        ['pre-cycad', null, 0.2, 0.1, 0.3], ['pre-horsetail', null, 0.78, 0.25, 0.18]],
    fantasy: [['fan-mushroom', 'mushroom', 0.08, 0.7, 0.16], ['fan-crystal', 'crystal', 0.35, 0.4, 0.14], ['fan-mushroom', 'mushroom', 0.68, 0.55, 0.12, '#ff9df0'], ['fan-crystal', 'crystal', 0.92, 0.9, 0.2, '#7ef9ff'],
        ['fan-lantern', null, 0.2, 0.1, 0.3], ['fan-runestone', null, 0.55, 0.12, 0.16], ['fan-flower', null, 0.82, 0.3, 0.14]],
};
/** 全班里程碑：[AI 道具 ID, x, z, 高度比例]（AI 背景板模式使用；SVG 背景模式畫在背景裡） */
export const MILESTONE_LAYOUT = Object.freeze([['ms-1', 0.47, 0.98, 0.07], ['ms-2', 0.26, 0.12, 0.16], ['ms-3', 0.95, 0.04, 0.42], ['ms-4', 0.64, 0.3, 0.15], ['ms-5', 0.05, 0.02, 0.36], ['ms-6', 0.77, 0.1, 0.2]]);

/** 回傳這個世界的道具：{ kind, art, x, z, h, svg }（art 有值時用 AI 圖；svg 是備用） */
export const zooProps = (world, hasArt = () => false) => (LAYOUT[world] || LAYOUT.land)
    .map(([art, kind, x, z, h, color]) => hasArt(art) ? { kind: art, art, x, z, h, svg: null } : kind ? { kind, art: null, x, z, h, svg: BUILD[kind](color) } : null)
    .filter(Boolean);
