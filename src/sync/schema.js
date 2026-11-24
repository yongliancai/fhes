// Google 試算表結構：每個資料表一個工作表（sheet）。
// 每列固定前 7 欄供同步使用，之後是給老師閱讀的欄位（App 不讀，手動修改無效）。
//   A id | B rev | C hash | D updatedAt | E deleted | F device | G data(JSON) | H… 可讀欄位
// 刪除只寫 deleted=1，data 欄保留（墓碑），雲端不會真的丟資料。
export const SCHEMA_VERSION = 1;
export const FIXED_COLS = ['id', 'rev', 'hash', 'updatedAt', 'deleted', 'device', 'data'];

const t = (ts) => ts ? new Date(ts).toISOString() : '';
const j = (v) => JSON.stringify(v ?? null);

/** table：本機資料表名稱（= 備份鍵名）；sheet：工作表名稱；readable：可讀欄位 */
export const SYNC_TABLES = Object.freeze([
    { table: 'classes', sheet: 'Classes', readable: [['name', c => c.name], ['groupCount', c => c.groupCount], ['deleted', c => c.deleted ? 1 : 0], ['hwTypes', c => (c.hwTypes || []).map(x => x.name + (x.active ? '' : '(停用)')).join('、')], ['groupWorlds', c => j(c.groupWorlds)]] },
    { table: 'students', sheet: 'Students', readable: [['classId', s => s.classId], ['seat', s => s.seat], ['name', s => s.name], ['group', s => s.group ?? ''], ['removed', s => s.removed ? 1 : 0]] },
    { table: 'events', sheet: 'ScoreEvents', readable: [['classId', e => e.classId], ['date', e => e.date], ['time', e => t(e.ts)], ['session', e => e.session], ['targetType', e => e.targetType], ['targetId', e => e.targetId], ['kind', e => e.kind], ['delta', e => e.delta], ['reason', e => e.reason], ['status', e => e.status], ['redeem', e => e.redeem ? 1 : 0]] },
    { table: 'dailySnapshots', sheet: 'DailySnapshots', readable: [['classId', s => s.classId], ['date', s => s.date], ['settledAt', s => t(s.settledAt)]] },
    { table: 'hwAssignments', sheet: 'HomeworkAssignments', readable: [['classId', a => a.classId], ['assignedDate', a => a.assignedDate], ['dueDate', a => a.dueDate || ''], ['typeId', a => a.typeId], ['title', a => a.title], ['archived', a => a.archived ? 1 : 0]] },
    { table: 'hwEvents', sheet: 'HomeworkEvents', immutable: true, readable: [['classId', e => e.classId], ['date', e => e.date], ['assignmentId', e => e.assignmentId], ['studentId', e => e.studentId], ['field', e => e.field], ['value', e => e.value], ['prev', e => e.prev ?? '']] },
    { table: 'xpEvents', sheet: 'XPEvents', readable: [['classId', x => x.classId], ['scope', x => x.scope], ['scopeId', x => x.scopeId], ['delta', x => x.delta], ['reason', x => x.reason], ['source', x => x.source], ['voided', x => x.voided ? 1 : 0]] },
    { table: 'specialItems', sheet: 'Catalog', readable: [['classId', s => s.classId], ['name', s => s.name], ['rarity', s => s.rarity], ['tagIds', s => (s.tagIds || []).join(',')], ['baseItemId', s => s.baseItemId || '']] },
    { table: 'grants', sheet: 'CollectionGrants', readable: [['classId', g => g.classId], ['ownerType', g => g.ownerType], ['ownerId', g => g.ownerId], ['itemId', g => g.itemId], ['source', g => g.source], ['acquiredAt', g => t(g.acquiredAt)], ['revoked', g => g.revoked ? 1 : 0]] },
    { table: 'settings', sheet: 'Settings', readable: [['value', s => j(s.value)]] },
    { table: 'syncMeta', sheet: 'SyncMeta', readable: [['device', m => m.id], ['lastSyncAt', m => t(m.lastSyncAt)], ['appVersion', m => m.appVersion]] },
]);
export const tableBySheet = new Map(SYNC_TABLES.map(x => [x.sheet, x]));
export const tableByName = new Map(SYNC_TABLES.map(x => [x.table, x]));

export const headerOf = (cfg) => [...FIXED_COLS, ...cfg.readable.map(r => r[0])];

/** 寫入用的一列（全部轉成字串或數字，以 RAW 寫入，學生姓名開頭是 = 也不會被當公式） */
export const toRow = (cfg, { id, rev, hash, updatedAt, deleted, device, entity }) => [
    String(id), rev, hash, updatedAt, deleted ? 1 : 0, device || '', JSON.stringify(entity ?? null),
    ...cfg.readable.map(([, f]) => { try { const v = entity ? f(entity) : ''; return v == null ? '' : (typeof v === 'number' ? v : String(v)); } catch { return ''; } }),
];

/** 讀回的一列 → 物件；壞掉的列回傳 { bad: true } */
export const fromRow = (values, rowNumber) => {
    const [id, rev, hash, updatedAt, deleted, device, data] = values;
    if (id == null || id === '') return null;
    let entity;
    try { entity = data ? JSON.parse(data) : null; } catch { return { row: rowNumber, id: String(id), bad: true }; }
    return { row: rowNumber, id: String(id), rev: Number(rev) || 0, hash: String(hash || ''), updatedAt: Number(updatedAt) || 0,
        deleted: Number(deleted) === 1 || deleted === true || deleted === 'TRUE', device: String(device || ''), entity };
};
