// v6.2 學生系統資料庫：加密備份、還原、保留期限。
//
// 備份：node server/backup.mjs backup  → 用 SQLite 線上備份 API 取得一致的快照（服務不用停），
//       以 AES-256-GCM 加密成 fhes-student-YYYYMMDD-HHmmss.db.enc，明文暫存檔立即刪除，超過保留天數的舊備份刪除。
// 還原：node server/backup.mjs restore <備份檔> <目標資料庫路徑>   （請先停止服務；目標已存在時拒絕，除非加 --force）
// 驗證：node server/backup.mjs verify <備份檔>   （解密到暫存檔、執行 integrity_check，不動正式資料庫）
//
// 設定（環境變數）：
//   FHES_DB_PATH            正式資料庫
//   FHES_BACKUP_DIR         備份資料夾（權限 700）
//   FHES_BACKUP_KEY_FILE    金鑰檔：64 個十六進位字元（32 bytes）。金鑰不可和備份放在同一個地方，也不可進 Git。
//   FHES_BACKUP_KEEP_DAYS   保留天數（預設 30）
// 產生金鑰：node server/backup.mjs keygen <金鑰檔路徑>   （檔案權限設為只有擁有者可讀）
import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('FHESBK1\n');           // 8 bytes：格式與版本
const IV_LEN = 12; const TAG_LEN = 16;
export const BACKUP_RE = /^fhes-student-\d{8}-\d{6}\.db\.enc$/;

export const readKey = (file) => {
    const hex = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('金鑰檔格式錯誤：需要 64 個十六進位字元');
    return Buffer.from(hex, 'hex');
};

export const encrypt = (plain, key) => {
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(MAGIC);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
};

export const decrypt = (blob, key) => {
    if (blob.length < MAGIC.length + IV_LEN + TAG_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是 FHES 備份檔');
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(MAGIC); d.setAuthTag(tag);
    try { return Buffer.concat([d.update(blob.subarray(MAGIC.length + IV_LEN, blob.length - TAG_LEN)), d.final()]); }
    catch { throw new Error('解密失敗：金鑰錯誤或備份檔已損壞'); }
};

const stamp = (t = new Date()) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(x => [x.type, x.value]));
    return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
};

/** 檢查一個（明文）SQLite 檔：完整性與 schema 版本 */
export const checkDb = (file) => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const ok = db.pragma('integrity_check', { simple: true });
        const version = db.pragma('user_version', { simple: true });
        const accounts = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'student_accounts'").get().n ? db.prepare('SELECT COUNT(*) n FROM student_accounts').get().n : 0;
        return { ok: ok === 'ok', integrity: ok, version, accounts };
    } finally { db.close(); }
};

export const backup = async ({ dbPath, dir, key, keepDays = 30, now = new Date() }) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `fhes-student-${stamp(now)}.db.enc`;
    const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}.db`);
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await src.backup(tmp); } finally { src.close(); }
    try {
        // 快照沿用 WAL 模式，開啟時會產生 -wal／-shm 明文旁檔：先改成一般日誌模式，結束時連旁檔一起刪除
        const t = new Database(tmp); t.pragma('journal_mode = DELETE'); t.close();
        const check = checkDb(tmp);
        if (!check.ok) throw new Error(`快照完整性檢查失敗：${check.integrity}`);
        const out = join(dir, name);
        writeFileSync(`${out}.part`, encrypt(readFileSync(tmp), key), { mode: 0o600 });
        renameSync(`${out}.part`, out);
        try { chmodSync(out, 0o600); } catch { /* Windows 不支援 */ }
        const removed = prune({ dir, keepDays, now });
        return { file: out, removed, accounts: check.accounts };
    } finally { removeWithSidecars(tmp); }
};

const removeWithSidecars = (f) => { for (const x of [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) if (existsSync(x)) unlinkSync(x); };

/** 刪除超過保留天數的備份（只刪符合命名規則的檔案；至少保留最新的 3 份） */
export const prune = ({ dir, keepDays = 30, now = new Date() }) => {
    const files = readdirSync(dir).filter(f => BACKUP_RE.test(f)).sort();
    const cutoff = now.getTime() - keepDays * 86400_000;
    const removable = files.slice(0, Math.max(0, files.length - 3)).filter(f => statSync(join(dir, f)).mtimeMs < cutoff);
    removable.forEach(f => unlinkSync(join(dir, f)));
    return removable;
};

export const restore = ({ file, target, key, force = false }) => {
    if (existsSync(target) && !force) throw new Error(`目標資料庫已存在：${target}（確定要覆蓋請加 --force，並先備份現在的檔案）`);
    const plain = decrypt(readFileSync(file), key);
    const tmp = `${target}.restore-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, plain, { mode: 0o600 });
    const check = checkDb(tmp);
    if (!check.ok) { removeWithSidecars(tmp); throw new Error(`備份內容完整性檢查失敗：${check.integrity}`); }
    for (const ext of ['-wal', '-shm']) if (existsSync(target + ext)) unlinkSync(target + ext);
    renameSync(tmp, target);
    return check;
};

export const verify = ({ file, key, tmpDir }) => {
    const tmp = join(tmpDir, `.verify-${randomBytes(6).toString('hex')}.db`);
    writeFileSync(tmp, decrypt(readFileSync(file), key), { mode: 0o600 });
    try { return checkDb(tmp); } finally { removeWithSidecars(tmp); }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [cmd, a, b] = process.argv.slice(2);
    const env = process.env;
    const need = (k) => { if (!env[k]) throw new Error(`缺少環境變數 ${k}`); return env[k]; };
    try {
        if (cmd === 'keygen') {
            if (!a) throw new Error('用法：node server/backup.mjs keygen <金鑰檔路徑>');
            if (existsSync(a)) throw new Error('金鑰檔已存在，不覆蓋（覆蓋會讓舊備份無法解密）');
            writeFileSync(a, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
            console.log(`已產生金鑰檔：${a}。請另外保存一份到安全的地方（例如學校的密碼保管系統）；遺失就無法還原備份。`);
        } else if (cmd === 'backup') {
            const r = await backup({ dbPath: need('FHES_DB_PATH'), dir: need('FHES_BACKUP_DIR'), key: readKey(need('FHES_BACKUP_KEY_FILE')), keepDays: Number(env.FHES_BACKUP_KEEP_DAYS || 30) });
            console.log(`備份完成：${basename(r.file)}（學生帳號 ${r.accounts} 個）；刪除過期備份 ${r.removed.length} 份`);
        } else if (cmd === 'verify') {
            const r = verify({ file: a, key: readKey(need('FHES_BACKUP_KEY_FILE')), tmpDir: dirname(resolve(a)) });
            console.log(`驗證：${r.ok ? '通過' : '失敗'}（schema v${r.version}，學生帳號 ${r.accounts} 個）`);
            if (!r.ok) process.exitCode = 1;
        } else if (cmd === 'restore') {
            const r = restore({ file: a, target: b, key: readKey(need('FHES_BACKUP_KEY_FILE')), force: process.argv.includes('--force') });
            console.log(`還原完成：${b}（schema v${r.version}，學生帳號 ${r.accounts} 個）。請重新啟動服務。`);
        } else {
            console.log('用法：node server/backup.mjs keygen <金鑰檔> | backup | verify <備份檔> | restore <備份檔> <目標資料庫> [--force]');
            process.exitCode = 2;
        }
    } catch (e) { console.error(`失敗：${e.message}`); process.exitCode = 1; }
}
