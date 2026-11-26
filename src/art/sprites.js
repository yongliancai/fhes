// 角色圖像來源：有核准的 AI 公仔圖（assets/creatures/*.webp）就用圖片，否則退回原創佔位 SVG。
import { ART_ASSETS } from '../data/art-manifest.js';
import { creatureSVG } from './creatures.js';

/** 這個收藏有沒有正式圖片 */
export const hasArt = (id) => !!ART_ASSETS[id];

/** 依成長階段選圖：0–1 用幼年版（沒有就用成年版），2–3 用成年版 */
export const artUrl = (id, stage = 3) => {
    const st = ART_ASSETS[id];
    if (!st) return null;
    const pick = stage <= 1 && st.includes('young') ? 'young' : st.includes('adult') ? 'adult' : st[0];
    return `assets/creatures/${id}_${pick}.webp`;
};
/** 沒有幼年圖時，用縮放表現成長（有幼年圖時幼年圖本身就比較小） */
export const stageScale = (id, stage = 3) => {
    const young = ART_ASSETS[id]?.includes('young');
    return young ? [0.86, 0.94, 0.94, 1][stage] ?? 1 : [0.74, 0.84, 0.94, 1][stage] ?? 1;
};

/**
 * 卡片、詳情、慶祝畫面用的角色圖。特殊收藏用 baseItemId 對應的圖。
 * 回傳 <img>（正式圖）或 <svg>（佔位）。
 */
export const creatureArt = (item, { size = 96, silhouette = false, stage = 3, label = null, artId = null } = {}) => {
    const id = artId || item.baseItemId || item.id;
    const url = artUrl(id, stage);
    if (!url) return creatureSVG(item, { size, silhouette, stage, label });
    const img = document.createElement('img');
    img.src = url;
    img.width = size; img.height = size;
    img.alt = label || (silhouette ? '尚未解鎖的收藏' : item.name);
    img.decoding = 'async';
    img.loading = 'lazy';
    img.draggable = false;
    img.className = 'creature creature-img' + (silhouette ? ' silhouette' : '');
    if (!silhouette) img.style.transform = `scale(${stageScale(id, stage)})`;
    return img;
};
