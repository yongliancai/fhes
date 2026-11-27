// v6.2 學生園區的角色圖（P5 美術對接）：用穩定的圖鑑 ID 查圖片清單；有核准的圖就用圖片，沒有就退回原創 SVG。
// 只有經過人工核准、後製後列入 src/data/art-manifest.js 的圖片會被使用（候選圖只留在美術分支）。
import { ART_ASSETS } from '../data/art-manifest.js';
import { creatureSVG } from './creatures.js';

/** 依成長階段選圖（與美術分支 sprites.js 規則相同）：0–1 用幼年版（沒有就用成年版），2–3 用成年版 */
export const pickArtFile = (manifest, id, stage = 3) => {
    const st = manifest?.[id];
    if (!st?.length) return null;
    const pick = stage <= 1 && st.includes('young') ? 'young' : st.includes('adult') ? 'adult' : st[0];
    return `/assets/creatures/${id}_${pick}.webp`;
};

const NS = 'http://www.w3.org/2000/svg';
/** 園區用：回傳 <svg>（可放進場景）。特殊收藏用 baseItemId 的圖 */
export const sceneCreature = (item, { stage = 3, artId = null, manifest = ART_ASSETS } = {}) => {
    const url = pickArtFile(manifest, artId || item.id, stage);
    if (!url) return creatureSVG(item, { stage });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', item.name);
    svg.setAttribute('class', 'creature creature-img');
    const img = document.createElementNS(NS, 'image');
    const scale = [0.74, 0.84, 0.94, 1][Math.max(0, Math.min(3, stage))];
    const size = 120 * scale;
    img.setAttribute('href', url); img.setAttribute('x', String((120 - size) / 2)); img.setAttribute('y', String(120 - size));
    img.setAttribute('width', String(size)); img.setAttribute('height', String(size));
    svg.append(img);
    return svg;
};
