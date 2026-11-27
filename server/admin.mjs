// 主機上的管理備援（只在網頁管理壞掉時用；docs/V62-MULTICLASS-DESIGN.md §7）。
// 用法：FHES_DB_PATH=/path/to/student.db node server/admin.mjs <指令>
//   list-teachers                 列出老師（id、狀態、註冊方式、班級名稱）
//   suspend <teacherId>           停權並登出該老師
//   unsuspend <teacherId>         恢復
// 每個動作都記入稽核（actor_kind = 'cli'）。不提供重設學生密碼：那要經過網頁上的申請與核准。
import { openDb } from './src/db.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** @returns {{ code: number, out: string }} */
export const runAdminCli = (db, [cmd, arg] = [], now = Date.now()) => {
    const audit = (action, target) => db.prepare("INSERT INTO audit_events (ts, actor_kind, actor_id, action, target) VALUES (?, 'cli', NULL, ?, ?)").run(now, action, target);
    if (cmd === 'list-teachers') {
        const classes = db.prepare('SELECT name FROM classes WHERE teacher_id = ? ORDER BY created_at');
        const rows = db.prepare('SELECT * FROM teachers ORDER BY created_at').all()
            .map(t => [t.id, t.status, t.signup, new Date(t.created_at).toISOString().slice(0, 10), classes.all(t.id).map(c => c.name).join('、')].join('\t'));
        return { code: 0, out: rows.join('\n') || '（沒有老師）' };
    }
    if (cmd === 'suspend' || cmd === 'unsuspend') {
        if (!/^t_[A-Za-z0-9_-]{2,64}$/.test(arg || '')) return { code: 2, out: '請指定老師 id（t_ 開頭）' };
        const status = cmd === 'suspend' ? 'suspended' : 'active';
        const r = db.prepare('UPDATE teachers SET status = ? WHERE id = ?').run(status, arg);
        if (!r.changes) return { code: 1, out: `找不到老師 ${arg}` };
        if (status === 'suspended') db.prepare("UPDATE sessions SET revoked_at = ? WHERE kind = 'teacher' AND subject_id = ? AND revoked_at IS NULL").run(now, arg);
        audit(`teacher.${cmd}`, arg);
        return { code: 0, out: `${arg} → ${status}` };
    }
    return { code: 2, out: '指令：list-teachers | suspend <teacherId> | unsuspend <teacherId>' };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.env.FHES_DB_PATH) { console.error('請設定 FHES_DB_PATH'); process.exit(2); }
    const db = openDb(process.env.FHES_DB_PATH);
    const { code, out } = runAdminCli(db, process.argv.slice(2));
    db.close();
    (code ? console.error : console.log)(out);
    process.exit(code);
}
