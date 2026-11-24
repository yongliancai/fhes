// 備份格式：讀取 v4（班級陣列）/ v5 / v5.1 / v6，統一成同一種 payload。
// 規則：較新版本的備份拒絕讀入（避免默默降級丟欄位）；缺少的資料表一律補成空陣列。

export const BACKUP_FORMAT = 'classroom-powerhouse';

/** payload 內的資料表（備份 JSON 的鍵名） */
export const BACKUP_TABLES = ['classes', 'students', 'events', 'dailySnapshots',
    // v6 新增：作業、XP、圖鑑
    'hwAssignments', 'hwEvents', 'xpEvents', 'specialItems', 'grants'];

export const isV4Data = (d) => Array.isArray(d) && d.every(c => c && Array.isArray(c.students));

/** v4 的 allClasses 陣列 → { classes, students, events }；舊分數轉成一筆「期初結轉」 */
export const convertV4 = (arr, { uid, now = Date.now(), today, newClassObj }) => {
    const out = { classes: [], students: [], events: [] };
    arr.forEach((c, ci) => {
        if (!c || !Array.isArray(c.students)) return;
        const cls = { ...newClassObj(String(c.name || `班級 ${ci + 1}`), Number(c.groupCount) || 4, { id: uid(), now }), id: String(c.id ?? uid()), createdAt: now + ci };
        out.classes.push(cls);
        c.students.forEach((s, si) => {
            const st = { id: String(s.id ?? uid()), classId: cls.id, seat: si + 1, name: String(s.name ?? `${si + 1}號`), group: Number.isInteger(s.group) ? s.group : null, removed: false };
            out.students.push(st);
            const score = Number(s.score) || 0;
            if (score !== 0) out.events.push({ id: uid(), classId: cls.id, ts: now, date: today, targetType: 'student', targetId: st.id, kind: 'score', delta: score, reason: '期初結轉', undone: false, undoOf: null, batchId: 'migrate-v4' });
        });
    });
    return out;
};

const emptyPayload = () => Object.fromEntries(BACKUP_TABLES.map(k => [k, []]));

/** 解析備份；失敗丟出含中文說明的 Error */
export const parseBackup = (data, { dataVersion, convertV4: conv }) => {
    if (isV4Data(data)) return { kind: 'v4', ...emptyPayload(), meta: {}, ...conv(data) };
    if (data && data.format === BACKUP_FORMAT && Array.isArray(data.classes)) {
        if ((data.version || 0) > dataVersion) throw new Error('這個備份來自較新版本，請先更新程式。');
        const arr = (k) => Array.isArray(data[k]) ? data[k] : [];
        return { kind: `v${data.version}`, ...Object.fromEntries(BACKUP_TABLES.map(k => [k, arr(k)])), meta: data.meta || {}, exportedAtLocal: data.exportedAtLocal };
    }
    throw new Error('檔案格式錯誤，不是班級動力站的備份。');
};

/** 由記憶體狀態組出備份 JSON（state 的鍵與 BACKUP_TABLES 相同，snapshots 例外） */
export const buildBackup = (state, { dataVersion, appVersion, now = Date.now(), exportedAtLocal = '', meta = {} }) => ({
    format: BACKUP_FORMAT, version: dataVersion, appVersion, exportedAt: now, exportedAtLocal,
    ...Object.fromEntries(BACKUP_TABLES.map(k => [k, state[k] || []])),
    meta,
});

/** 備份摘要：用於導入前預覽與導入後對帳 */
export const backupSummary = (p) => ({
    classes: (p.classes || []).filter(c => !c.deleted).length,
    ...Object.fromEntries(BACKUP_TABLES.filter(k => k !== 'classes').map(k => [k, (p[k] || []).length])),
});

/** v5.1 能讀的資料表（回退到 v5.1 時使用；作業、XP、圖鑑不包含在內） */
export const V51_TABLES = ['classes', 'students', 'events', 'dailySnapshots'];
/** 匯出 v5.1 相容備份：版本標 5.1、只含 v5.1 認得的資料表（多出來的欄位 v5.1 會忽略） */
export const buildLegacyV51Backup = (state, { now = Date.now(), exportedAtLocal = '', meta = {} } = {}) => ({
    format: BACKUP_FORMAT, version: 5.1, appVersion: 'v6.0 → v5.1 相容匯出', exportedAt: now, exportedAtLocal,
    ...Object.fromEntries(V51_TABLES.map(k => [k, state[k] || []])),
    meta,
    note: '此檔供回退到 v5.1 使用；不含作業、XP、圖鑑資料（請另外保留 v6 完整備份）。',
});
