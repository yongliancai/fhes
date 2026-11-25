// v6.2 學生系統的「投影」（ADR-020）：教師端用 v6.1 既有規則，算出每位學生「只看得到自己」的最小資料。
// 純函式：教師端（瀏覽器）建構與雜湊，後端（Node）驗證與雜湊，共用同一份程式。
// 不變的規則：
//   - 分數只計已確認的紀錄（computeTotals）；不發布愛心（個人負向紀錄不給學生系統）。
//   - 作業「繳交」與「訂正」分開；unchecked ≠ missing、submitted ≠ done（projectRecords）。
//   - 小組 XP、成長階段沿用 xpLedger／growthStage；照顧值不在這裡，也不會影響這裡的任何數字。
import { computeTotals } from './score.js';
import { projectRecords, getRecord, typeName, SUBMISSION, CORRECTION } from './homework.js';
import { xpLedger, xpOf, groupKey } from './xp.js';
import { activeGrants, growthStage } from './collection.js';
import { addDays } from './dates.js';
import { stableStringify } from './ids.js';
import { catalogById, WORLDS, RARITIES } from '../data/catalog.js';

export const PROJECTION_SCHEMA = 1;
export const HOMEWORK_WINDOW_DAYS = 60;
export const LIMITS = Object.freeze({ students: 80, groups: 20, homework: 120, animals: 120, text: 60, title: 80 });
export const NAME_MODES = Object.freeze(['name', 'seat']);

const groupName = (g) => `第 ${g} 小隊`;
const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * 由一個班級的 v6.1 資料建立投影。
 * @param {{ cls, students, events, hwAssignments, hwEvents, xpEvents, grants, specialItems }} data 只需要這個班級的資料（多給的會被過濾）
 * @param {{ today: string, nameMode?: 'name'|'seat' }} opts today：Asia/Taipei 日期 YYYY-MM-DD
 */
export const buildClassProjection = (data, { today, nameMode = 'name' }) => {
    const { cls } = data;
    if (!cls?.id) throw new Error('缺少班級');
    if (!NAME_MODES.includes(nameMode)) throw new Error('不明的姓名顯示方式');
    const mine = (arr) => (arr || []).filter(x => x.classId === cls.id);
    const students = mine(data.students).filter(s => !s.removed).sort((a, b) => (a.seat ?? 999) - (b.seat ?? 999));
    const events = mine(data.events);
    const { totals } = computeTotals(events);
    const ledger = xpLedger(events, mine(data.xpEvents));
    const since = addDays(today, -HOMEWORK_WINDOW_DAYS);
    const assignments = mine(data.hwAssignments).filter(a => !a.archived && (a.assignedDate || '') >= since)
        .sort((a, b) => (b.assignedDate || '').localeCompare(a.assignedDate || '') || String(a.id).localeCompare(String(b.id)))
        .slice(0, LIMITS.homework);
    const records = projectRecords(mine(data.hwEvents), assignments);
    const specials = new Map(mine(data.specialItems).map(s => [s.id, s]));
    const groupCount = Math.min(Number(cls.groupCount) || 0, LIMITS.groups);

    const studentDtos = students.slice(0, LIMITS.students).map(s => {
        const t = totals.get(s.id) || { score: 0, earned: 0 };
        const g = Number.isInteger(s.group) && s.group >= 1 && s.group <= groupCount ? s.group : null;
        return {
            studentId: String(s.id),
            seat: Number.isFinite(Number(s.seat)) ? Number(s.seat) : null,
            name: nameMode === 'seat' ? `${s.seat ?? ''}號` : clip(s.name, LIMITS.text),
            groupId: g,
            score: { score: t.score, earned: t.earned },
            homework: assignments.map(a => {
                const r = getRecord(records, a.id, s.id);
                return {
                    assignmentId: String(a.id), title: clip(a.title || typeName(cls, a.typeId), LIMITS.title), type: clip(typeName(cls, a.typeId), LIMITS.text),
                    assignedDate: a.assignedDate || null, dueDate: a.dueDate || null,
                    submission: r.submission, correction: r.correction, late: !!r.late,
                };
            }),
        };
    });

    const groups = Array.from({ length: groupCount }, (_, i) => i + 1).map(g => ({
        groupId: g,
        name: groupName(g),
        worldId: cls.groupWorlds?.[g] || null,
        xp: xpOf(ledger, 'group', groupKey(cls.id, g)),
        animals: activeGrants(mine(data.grants), cls.id, 'group', g).slice(0, LIMITS.animals).map(gr => {
            const sp = gr.special ? specials.get(gr.itemId) : null;
            const base = catalogById.get(sp ? sp.baseItemId : gr.itemId);
            return {
                itemId: String(gr.itemId),
                baseItemId: base?.id || null,
                special: !!gr.special,
                name: clip(sp ? sp.name : base?.name, LIMITS.text),
                rarity: sp?.rarity || base?.rarity || 'common',
                stage: growthStage({ ledger, grant: gr }).stage,
            };
        }),
    }));

    return { schema: PROJECTION_SCHEMA, className: clip(cls.name, LIMITS.text), nameMode, students: studentDtos, groups };
};

// ------------------------------------------------------------------ 驗證（後端使用；也讓教師端先自我檢查）
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isDate = (v) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
const isInt = (v) => Number.isInteger(v);
const onlyKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const RARITY_IDS = RARITIES.map(r => r.id);
const WORLD_IDS = WORLDS.map(w => w.id);

/** 回傳錯誤字串陣列；空陣列 = 合法 */
export const validateProjection = (p) => {
    const err = [];
    if (!onlyKeys(p, ['schema', 'className', 'nameMode', 'students', 'groups'])) return ['投影格式錯誤'];
    if (p.schema !== PROJECTION_SCHEMA) err.push('schema 版本不符');
    if (!isStr(p.className, LIMITS.text)) err.push('className');
    if (!NAME_MODES.includes(p.nameMode)) err.push('nameMode');
    if (!Array.isArray(p.students) || p.students.length > LIMITS.students) return [...err, 'students'];
    if (!Array.isArray(p.groups) || p.groups.length > LIMITS.groups) return [...err, 'groups'];
    const groupIds = new Set();
    p.groups.forEach((g, i) => {
        if (!onlyKeys(g, ['groupId', 'name', 'worldId', 'xp', 'animals'])) { err.push(`groups[${i}]`); return; }
        if (!isInt(g.groupId) || g.groupId < 1 || g.groupId > LIMITS.groups || groupIds.has(g.groupId)) err.push(`groups[${i}].groupId`);
        groupIds.add(g.groupId);
        if (!isStr(g.name, LIMITS.text)) err.push(`groups[${i}].name`);
        if (g.worldId !== null && !WORLD_IDS.includes(g.worldId)) err.push(`groups[${i}].worldId`);
        if (!isInt(g.xp) || g.xp < 0) err.push(`groups[${i}].xp`);
        if (!Array.isArray(g.animals) || g.animals.length > LIMITS.animals) { err.push(`groups[${i}].animals`); return; }
        const seen = new Set();
        g.animals.forEach((a, j) => {
            const at = `groups[${i}].animals[${j}]`;
            if (!onlyKeys(a, ['itemId', 'baseItemId', 'special', 'name', 'rarity', 'stage'])) { err.push(at); return; }
            if (!isStr(a.itemId, 64) || !a.itemId || seen.has(a.itemId)) err.push(`${at}.itemId`);
            seen.add(a.itemId);
            if (a.baseItemId !== null && !catalogById.has(a.baseItemId)) err.push(`${at}.baseItemId`);
            if (!a.special && a.itemId !== a.baseItemId) err.push(`${at}.itemId 必須是圖鑑 ID`);
            if (typeof a.special !== 'boolean') err.push(`${at}.special`);
            if (!isStr(a.name, LIMITS.text)) err.push(`${at}.name`);
            if (!RARITY_IDS.includes(a.rarity)) err.push(`${at}.rarity`);
            if (!isInt(a.stage) || a.stage < 0 || a.stage > 3) err.push(`${at}.stage`);
        });
    });
    const ids = new Set();
    p.students.forEach((s, i) => {
        const at = `students[${i}]`;
        if (!onlyKeys(s, ['studentId', 'seat', 'name', 'groupId', 'score', 'homework'])) { err.push(at); return; }
        if (!isStr(s.studentId, 64) || !s.studentId || ids.has(s.studentId)) err.push(`${at}.studentId`);
        ids.add(s.studentId);
        if (s.seat !== null && !isInt(s.seat)) err.push(`${at}.seat`);
        if (!isStr(s.name, LIMITS.text)) err.push(`${at}.name`);
        if (s.groupId !== null && !groupIds.has(s.groupId)) err.push(`${at}.groupId`);
        if (!onlyKeys(s.score, ['score', 'earned']) || !isInt(s.score.score) || !isInt(s.score.earned)) err.push(`${at}.score`);
        if (!Array.isArray(s.homework) || s.homework.length > LIMITS.homework) { err.push(`${at}.homework`); return; }
        s.homework.forEach((h, j) => {
            const hat = `${at}.homework[${j}]`;
            if (!onlyKeys(h, ['assignmentId', 'title', 'type', 'assignedDate', 'dueDate', 'submission', 'correction', 'late'])) { err.push(hat); return; }
            if (!isStr(h.assignmentId, 64) || !isStr(h.title, LIMITS.title) || !isStr(h.type, LIMITS.text)) err.push(hat);
            if (!isDate(h.assignedDate) || !isDate(h.dueDate)) err.push(`${hat}.date`);
            if (!(h.submission in SUBMISSION)) err.push(`${hat}.submission`);
            if (h.correction !== null && !(h.correction in CORRECTION)) err.push(`${hat}.correction`);
            if (h.correction !== null && h.submission !== 'submitted') err.push(`${hat}.correction 只能用在已交`);
            if (typeof h.late !== 'boolean') err.push(`${hat}.late`);
        });
    });
    return err;
};

/** 內容雜湊（SHA-256，十六進位）。瀏覽器與 Node 22 都有 crypto.subtle */
export const projectionHash = async (p, subtle = globalThis.crypto?.subtle) => {
    const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(p))));
    return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
};
