// 收藏（圖鑑）規則：解鎖、授予、撤銷、成長階段、特殊收藏與標籤
//
// 不變量：
//  - 授予紀錄（grant）ID 由「班級＋擁有者＋收藏物」決定 → 同一個解鎖重送幾次都只有一件
//  - 收藏永久保留：扣分、兌換、XP 更正、換組、改主題世界都不會刪除收藏；只有老師「撤銷誤發」會標記 revoked（保留紀錄）
//  - 探索能量 = 本獎勵期間 XP − 本期間用 XP 解鎖所花費；主要世界不提供任何倍率
//  - 特殊收藏有獨立 ID、獨立圖鑑，不占基本 12 格；每件最多 2 個標籤；標籤只分類、不能當解鎖條件
import { CATALOG, RARITIES, RARITY_QUOTA, WORLDS, catalogById, GROWTH_TRACKS } from '../data/catalog.js';
import { xpOf } from './xp.js';

export const DEFAULT_COSTS = Object.freeze({ common: 10, rare: 20, epic: 35, legendary: 60 });
export const STAGE_XP = Object.freeze([0, 10, 25, 45]);   // 取得後再累積多少 XP 進入下一階段
export const DEFAULT_TAGS = Object.freeze([
    { id: 'tag-festival', name: '節慶限定', builtin: true, active: true },
    { id: 'tag-memorial', name: '紀念版', builtin: true, active: true },
    { id: 'tag-skin', name: '特殊造型', builtin: true, active: true },
    { id: 'tag-coop', name: '合作紀念', builtin: true, active: true },
].map(Object.freeze));
export const MAX_TAGS_PER_ITEM = 2;

/** 班級補值器 */
export const fillCollectionDefaults = (c, fill) => {
    let changed = false;
    if (fill('collection', { mode: 'sequential', costs: { ...DEFAULT_COSTS }, periodStart: 0 })) changed = true;
    if (fill('groupWorlds', {})) changed = true;
    if (fill('collectionTags', DEFAULT_TAGS.map(t => ({ ...t })))) changed = true;
    return changed;
};

// ------------------------------------------------------------------ 圖鑑驗證
/** 檢查基本圖鑑：6 世界 × 12、5/4/2/1、ID 唯一 → 回傳錯誤陣列 */
export const validateCatalog = (catalog = CATALOG, worlds = WORLDS) => {
    const errors = [];
    const ids = new Set();
    for (const it of catalog) { if (ids.has(it.id)) errors.push(`重複 ID：${it.id}`); ids.add(it.id); }
    for (const w of worlds) {
        const items = catalog.filter(c => c.world === w.id);
        if (items.length !== 12) errors.push(`${w.name} 應有 12 項，實際 ${items.length}`);
        for (const [r, n] of Object.entries(RARITY_QUOTA)) {
            const k = items.filter(c => c.rarity === r).length;
            if (k !== n) errors.push(`${w.name} ${r} 應有 ${n} 項，實際 ${k}`);
        }
    }
    if (worlds.length !== 6) errors.push(`世界數應為 6，實際 ${worlds.length}`);
    for (const it of catalog) if (!RARITIES.some(r => r.id === it.rarity)) errors.push(`${it.id} 稀有度不明`);
    return errors;
};

// ------------------------------------------------------------------ 授予
export const grantId = (classId, ownerType, ownerId, itemId) => `g|${classId}|${ownerType}|${ownerId}|${itemId}`;
export const ownerKey = (classId, ownerType, ownerId) => ownerType === 'group' ? `${classId}|${ownerId}` : classId;
export const activeGrants = (grants, classId, ownerType, ownerId) =>
    grants.filter(g => g.classId === classId && g.ownerType === ownerType && String(g.ownerId) === String(ownerId) && !g.revoked);
export const owns = (grants, classId, ownerType, ownerId, itemId) =>
    grants.some(g => g.id === grantId(classId, ownerType, ownerId, itemId) && !g.revoked);

const rarityRank = (r) => RARITIES.find(x => x.id === r)?.rank ?? 0;

/** 探索能量：本期間 XP − 本期間 XP 解鎖花費 */
export const energyOf = ({ ledger, grants, c, ownerType, ownerId }) => {
    const since = c.collection?.periodStart || 0;
    const scope = ownerType === 'group' ? 'group' : 'class';
    const earned = xpOf(ledger, scope, ownerKey(c.id, ownerType, ownerId), since);
    const spent = activeGrants(grants, c.id, ownerType, ownerId).filter(g => g.source === 'xp' && g.acquiredAt >= since).reduce((n, g) => n + (g.cost || 0), 0);
    return { earned, spent, available: earned - spent };
};

/**
 * 能不能用 XP 解鎖某基本收藏？回傳 { ok, reason, cost }
 * 逐步揭露（sequential）：同一世界要先收齊較低稀有度，才能解鎖下一級；自由選擇（free）不限。
 */
export const canUnlock = ({ ledger, grants, c, ownerType, ownerId, itemId }) => {
    const item = catalogById.get(itemId);
    if (!item) return { ok: false, reason: '找不到這個收藏' };
    const cost = (c.collection?.costs || DEFAULT_COSTS)[item.rarity];
    if (owns(grants, c.id, ownerType, ownerId, itemId)) return { ok: false, reason: '已經收藏了', cost };
    if ((c.collection?.mode || 'sequential') === 'sequential') {
        const lower = CATALOG.filter(x => x.world === item.world && rarityRank(x.rarity) < rarityRank(item.rarity));
        const missing = lower.filter(x => !owns(grants, c.id, ownerType, ownerId, x.id));
        if (missing.length) return { ok: false, reason: `要先收齊這個世界較低稀有度的 ${missing.length} 項`, cost, locked: true };
    }
    const e = energyOf({ ledger, grants, c, ownerType, ownerId });
    if (e.available < cost) return { ok: false, reason: `探索能量不足（還差 ${cost - e.available}）`, cost };
    return { ok: true, cost };
};

/** 建立授予紀錄（source：xp / teacher / special）；同一件已存在（含曾撤銷）→ 回傳 null 或重新啟用 */
export const makeGrant = ({ c, ownerType, ownerId, itemId, source, cost = 0, note = '', now, special = false }, existing = []) => {
    const id = grantId(c.id, ownerType, ownerId, itemId);
    const old = existing.find(g => g.id === id);
    if (old && !old.revoked) return null;
    return { id, classId: c.id, ownerType, ownerId: String(ownerId), itemId, special: !!special, source, cost: source === 'xp' ? cost : 0,
        note, acquiredAt: now, revoked: false, revokedAt: null, revokeNote: '', updatedAt: now };
};

/** 撤銷誤發（保留紀錄）；探索能量會退回（不再計入花費） */
export const revokeGrant = (g, note, now) => {
    if (!note || !String(note).trim()) throw new Error('請填寫撤銷原因');
    return { ...g, revoked: true, revokedAt: now, revokeNote: String(note).trim(), updatedAt: now };
};

/** 成長階段：取得之後擁有者再累積的 XP（不受獎勵期間重設影響）→ 0..3 */
export const growthStage = ({ ledger, grant }) => {
    const scope = grant.ownerType === 'group' ? 'group' : 'class';
    const key = ownerKey(grant.classId, grant.ownerType, grant.ownerId);
    const since = xpOf(ledger, scope, key, grant.acquiredAt);
    let stage = 0;
    STAGE_XP.forEach((need, i) => { if (since >= need) stage = i; });
    const next = STAGE_XP[stage + 1];
    return { stage, xpSince: since, toNext: next == null ? 0 : next - since };
};
export const stageName = (item, stage) => (GROWTH_TRACKS[item?.track] || GROWTH_TRACKS.animal)[stage];

/** 某擁有者在每個世界的進度 */
export const worldProgress = (grants, c, ownerType, ownerId) => Object.fromEntries(WORLDS.map(w => [w.id,
    CATALOG.filter(x => x.world === w.id && owns(grants, c.id, ownerType, ownerId, x.id)).length]));

// ------------------------------------------------------------------ 特殊收藏與標籤
export const validateSpecialItem = (item, tags, { isNew = true, previousTagIds = [] } = {}) => {
    const errors = [];
    if (!String(item.name || '').trim()) errors.push('請輸入名稱');
    if (!RARITIES.some(r => r.id === item.rarity)) errors.push('請選擇稀有度');
    const ids = item.tagIds || [];
    if (ids.length > MAX_TAGS_PER_ITEM) errors.push(`每件最多 ${MAX_TAGS_PER_ITEM} 個標籤`);
    if (new Set(ids).size !== ids.length) errors.push('標籤不能重複');
    for (const id of ids) {
        const t = tags.find(x => x.id === id);
        if (!t) errors.push('標籤不存在');
        // 停用的標籤：舊收藏原本就有的可以保留；新選擇不行
        else if (!t.active && (isNew || !previousTagIds.includes(id))) errors.push(`「${t.name}」已停用，不能選`);
    }
    if (item.baseItemId && !catalogById.has(item.baseItemId)) errors.push('對應的基本收藏不存在');
    return errors;
};
export const makeSpecialItem = ({ classId, name, rarity, tagIds = [], baseItemId = null, emoji = '', note = '' }, { uid, now }) =>
    ({ id: `sp-${uid()}`, classId, name: String(name).trim(), rarity, tagIds: [...tagIds], baseItemId: baseItemId || null, emoji: String(emoji || '').trim().slice(0, 4), note: String(note || '').trim(), createdAt: now, updatedAt: now, archived: false });

export const addTag = (c, name, id) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('請輸入標籤名稱');
    if (c.collectionTags.some(t => t.name === n)) throw new Error(`「${n}」已經存在`);
    const t = { id, name: n, builtin: false, active: true };
    c.collectionTags.push(t);
    return t;
};
/** 自訂標籤改名：以固定 ID 更新，所有引用自動顯示新名稱；預設標籤不改名 */
export const renameTag = (c, id, name) => {
    const t = c.collectionTags.find(x => x.id === id); const n = String(name || '').trim();
    if (!t) throw new Error('找不到標籤');
    if (t.builtin) throw new Error('預設標籤不能改名');
    if (!n) throw new Error('請輸入標籤名稱');
    if (c.collectionTags.some(x => x.id !== id && x.name === n)) throw new Error(`「${n}」已經存在`);
    t.name = n; return t;
};
export const setTagActive = (c, id, active) => { const t = c.collectionTags.find(x => x.id === id); if (!t) throw new Error('找不到標籤'); t.active = !!active; return t; };
/** 刪除前的影響預覽：哪些特殊收藏引用了它 */
export const tagImpact = (specialItems, tagId) => specialItems.filter(s => (s.tagIds || []).includes(tagId));
/** 刪除自訂標籤：只移除標籤與關聯，不刪任何收藏。回傳 { tags, updatedItems } */
export const deleteTag = (c, specialItems, tagId, now) => {
    const t = c.collectionTags.find(x => x.id === tagId);
    if (!t) throw new Error('找不到標籤');
    if (t.builtin) throw new Error('預設標籤不能刪除，可以停用');
    c.collectionTags = c.collectionTags.filter(x => x.id !== tagId);
    const updatedItems = tagImpact(specialItems, tagId).map(s => ({ ...s, tagIds: s.tagIds.filter(x => x !== tagId), updatedAt: now }));
    return { updatedItems };
};
export const tagName = (c, id) => c.collectionTags?.find(t => t.id === id)?.name ?? '（已刪除標籤）';
