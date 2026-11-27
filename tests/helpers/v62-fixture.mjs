// v6.2 合成測試資料（不隨 App 出貨）：兩個班、甲班 3 組、乙班 2 組，姓名全部是虛構的。
// 形狀與 v6.1 IndexedDB 相同（classes / students / events / hwAssignments / hwEvents / xpEvents / grants / specialItems）。
export const _synthetic = true;

const T0 = Date.parse('2026-11-20T08:00:00+08:00');
const at = (h) => T0 + h * 3600_000;
const ev = (o) => ({ session: '其他', status: 'confirmed', recordedBy: 'teacher', reviewNote: '', redeem: false, kind: 'score', xpv: 1, ...o });

export const buildFixture = () => {
    const classA = { id: 'cls-a', name: '合成甲班', groupCount: 3, groupWorlds: { 1: 'land', 2: 'ocean' }, hwTypes: [{ id: 'hwt-01', name: '國隨', active: true, builtin: true }], collection: { mode: 'free', costs: { common: 10, rare: 20, epic: 35, legendary: 60 }, periodStart: 0 } };
    const classB = { id: 'cls-b', name: '合成乙班', groupCount: 2, groupWorlds: { 1: 'sky' }, hwTypes: [{ id: 'hwt-01', name: '國隨', active: true, builtin: true }], collection: { mode: 'free', costs: { common: 10, rare: 20, epic: 35, legendary: 60 }, periodStart: 0 } };
    const stu = (classId, seat, name, group, extra = {}) => ({ id: `${classId}-s${seat}`, classId, seat, name, group, removed: false, ...extra });
    const students = [
        stu('cls-a', 1, '測試王小明', 1), stu('cls-a', 2, '測試李小華', 1), stu('cls-a', 3, '測試陳小美', 1),
        stu('cls-a', 4, '測試林小強', 2), stu('cls-a', 5, '測試張小芳', 2),
        stu('cls-a', 6, '測試黃小龍', 3), stu('cls-a', 7, '測試吳小雲', null),
        stu('cls-a', 8, '測試已轉出', 1, { removed: true }),
        stu('cls-b', 1, '測試趙小乙', 1), stu('cls-b', 2, '測試錢小乙', 1), stu('cls-b', 3, '測試孫小乙', 2), stu('cls-b', 4, '測試周小乙', 2),
    ];
    const events = [
        ev({ id: 'e1', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s1', delta: 5, ts: at(1), date: '2026-11-20', xpGroup: 1 }),
        ev({ id: 'e2', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s1', delta: 3, ts: at(2), date: '2026-11-20', xpGroup: 1, status: 'pending' }),
        ev({ id: 'e3', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s1', delta: 4, ts: at(3), date: '2026-11-20', xpGroup: 1, status: 'rejected' }),
        ev({ id: 'e4', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s1', delta: -2, ts: at(4), date: '2026-11-20', xpGroup: 1, redeem: true }),
        ev({ id: 'e5', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s1', delta: 1, ts: at(5), date: '2026-11-20', kind: 'heart', xpv: undefined }),
        ev({ id: 'e6', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s2', delta: 10, ts: at(6), date: '2026-11-20', xpGroup: 1 }),
        ev({ id: 'e7', classId: 'cls-a', targetType: 'group', targetId: 1, delta: 20, ts: at(7), date: '2026-11-20' }),
        ev({ id: 'e8', classId: 'cls-a', targetType: 'student', targetId: 'cls-a-s4', delta: 6, ts: at(8), date: '2026-11-20', xpGroup: 2 }),
        ev({ id: 'e9', classId: 'cls-b', targetType: 'student', targetId: 'cls-b-s1', delta: 9, ts: at(9), date: '2026-11-20', xpGroup: 1 }),
    ];
    const hwAssignments = [
        { id: 'hw-a1', classId: 'cls-a', typeId: 'hwt-01', title: '國語隨堂 1', assignedDate: '2026-11-18', dueDate: '2026-11-19', archived: false },
        { id: 'hw-a2', classId: 'cls-a', typeId: 'hwt-01', title: '國語隨堂 2', assignedDate: '2026-11-19', dueDate: '2026-11-20', archived: false },
        { id: 'hw-a-old', classId: 'cls-a', typeId: 'hwt-01', title: '很久以前', assignedDate: '2026-08-01', dueDate: '2026-08-02', archived: false },
        { id: 'hw-a-arch', classId: 'cls-a', typeId: 'hwt-01', title: '已封存', assignedDate: '2026-11-19', dueDate: null, archived: true },
        { id: 'hw-b1', classId: 'cls-b', typeId: 'hwt-01', title: '乙班作業', assignedDate: '2026-11-19', dueDate: null, archived: false },
    ];
    const hw = (id, assignmentId, studentId, field, value, ts, date) => ({ id, classId: studentId.startsWith('cls-a') ? 'cls-a' : 'cls-b', assignmentId, studentId, field, value, prevIds: [], ts, date });
    const hwEvents = [
        hw('h1', 'hw-a1', 'cls-a-s1', 'submission', 'submitted', at(1), '2026-11-19'),
        hw('h2', 'hw-a1', 'cls-a-s1', 'correction', 'needs', at(2), '2026-11-19'),
        hw('h3', 'hw-a1', 'cls-a-s2', 'submission', 'missing', at(1), '2026-11-19'),
        hw('h4', 'hw-a2', 'cls-a-s1', 'submission', 'submitted', at(3), '2026-11-21'),
        hw('h5', 'hw-b1', 'cls-b-s1', 'submission', 'exempt', at(3), '2026-11-19'),
    ];
    const xpEvents = [{ id: 'x1', classId: 'cls-a', scope: 'group', scopeId: 2, delta: 12, reason: '合成', source: 'manual', ts: at(9), voided: false }];
    const g = (classId, ownerId, itemId, extra = {}) => ({ id: `g|${classId}|group|${ownerId}|${itemId}`, classId, ownerType: 'group', ownerId: String(ownerId), itemId, special: false, source: 'teacher', cost: 0, acquiredAt: at(0), revoked: false, ...extra });
    const grants = [
        g('cls-a', 1, 'land-01'), g('cls-a', 1, 'land-02'), g('cls-a', 1, 'land-03', { revoked: true, revokeNote: '誤發' }),
        g('cls-a', 2, 'ocean-01'), g('cls-a', 2, 'sp-1', { special: true, source: 'special' }),
        g('cls-a', 3, 'tech-01'),
        { id: 'g|cls-a|class|cls-a|land-12', classId: 'cls-a', ownerType: 'class', ownerId: 'cls-a', itemId: 'land-12', special: false, source: 'teacher', cost: 0, acquiredAt: at(0), revoked: false },
        g('cls-b', 1, 'sky-01'), g('cls-b', 2, 'sky-02'),
    ];
    const specialItems = [{ id: 'sp-1', classId: 'cls-a', name: '合成特殊海豚', rarity: 'rare', tagIds: [], baseItemId: 'ocean-04' }];
    return { _synthetic: true, classes: [classA, classB], students, events, hwAssignments, hwEvents, xpEvents, grants, specialItems };
};

/** 取出一個班級的資料（buildClassProjection 的輸入） */
export const classData = (fx, classId) => ({ cls: fx.classes.find(c => c.id === classId), ...Object.fromEntries(['students', 'events', 'hwAssignments', 'hwEvents', 'xpEvents', 'grants', 'specialItems'].map(k => [k, fx[k]])) });
