// 舊資料（登入功能上線前、未歸屬任何 Google 帳號的本機資料）轉移規則 — 純函式。
// 原則（ADR-012）：
//   - 絕不自動指定給任何登入帳號；老師要看過預覽、逐班勾選、確認後才複製
//   - 「複製」不是「搬移」：舊資料原封不動留著，直到老師另外按「從這台電腦移除舊資料」
//   - 帳號裡已經有同一個班級 id 時不覆蓋，列為「略過」
//   - 匯入紀錄（哪些班、何時）存在帳號的 meta.legacyImport，可「復原這次匯入」
import { BACKUP_TABLES } from './backup.js';

const ownerOf = (table, x) => table === 'classes' ? x.id : x.classId;
const arr = (p, t) => Array.isArray(p?.[t]) ? p[t] : [];

/** 每個（未刪除的）舊班級的摘要：給老師預覽 */
export const legacySummary = (payload) => arr(payload, 'classes').filter(c => c && !c.deleted).map(c => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    students: arr(payload, 'students').filter(s => s.classId === c.id && !s.removed).length,
    events: arr(payload, 'events').filter(e => e.classId === c.id).length,
    homework: arr(payload, 'hwEvents').filter(e => e.classId === c.id).length,
    grants: arr(payload, 'grants').filter(e => e.classId === c.id).length,
}));

/**
 * 規劃匯入：只取勾選的班級與其所有附屬資料；帳號裡已有的班級 id 略過。
 * @returns {{ puts: Record<string, object[]>, imported: string[], skipped: string[], counts: Record<string, number> }}
 */
export const planLegacyImport = (payload, classIds, existingClassIds = []) => {
    const want = new Set(classIds.map(String));
    const have = new Set(existingClassIds.map(String));
    const alive = new Set(arr(payload, 'classes').filter(c => c && !c.deleted).map(c => String(c.id)));
    const imported = [...want].filter(id => alive.has(id) && !have.has(id));
    const skipped = [...want].filter(id => !imported.includes(id));
    const take = new Set(imported);
    const puts = Object.fromEntries(BACKUP_TABLES.map(t => [t, arr(payload, t).filter(x => x && take.has(String(ownerOf(t, x)))).map(x => structuredClone(x))]));
    const counts = Object.fromEntries(BACKUP_TABLES.map(t => [t, puts[t].length]));
    return { puts, imported, skipped, counts };
};

/** 復原匯入：列出帳號中屬於這些班級的所有資料 id（逐表） */
export const planUndoImport = (state, classIds) => {
    const take = new Set(classIds.map(String));
    return Object.fromEntries(BACKUP_TABLES.map(t => [t, arr(state, t).filter(x => take.has(String(ownerOf(t, x)))).map(x => x.id)]));
};

/** 舊資料是否有東西值得提示（至少一個未刪除的班級） */
export const hasLegacyContent = (payload) => arr(payload, 'classes').some(c => c && !c.deleted);
