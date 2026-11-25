// v6.2 學生系統資料庫：加密備份、還原、保留期限（合成資料、暫存資料夾）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDb } from '../server/src/db.mjs';
import { backup, restore, verify, prune, encrypt, decrypt, BACKUP_RE } from '../server/backup.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fhes-bk-'));
const seedDb = (file) => {
    const db = openDb(file);
    db.prepare('INSERT INTO teachers (id, account_hash, created_at) VALUES (?,?,?)').run('t1', 'h1', 1);
    db.prepare('INSERT INTO classes (id, teacher_id, local_class_id, created_at) VALUES (?,?,?,?)').run('c1', 't1', 'cls', 1);
    db.prepare("INSERT INTO student_accounts (id, class_id, local_student_id, username, password_hash, created_at, updated_at) VALUES ('s1','c1','x','abc3456','$argon2id$fake-hash',1,1)").run();
    db.prepare("INSERT INTO student_projections (class_id, local_student_id, data, version) VALUES ('c1','x','{\"name\":\"測試合成學生\"}',1)").run();
    return db;
};

test('backup is a consistent encrypted snapshot (no plaintext names or hashes); restore gives back the same data', async () => {
    const dir = tmp();
    try {
        const dbFile = join(dir, 'live.db'); const db = seedDb(dbFile);       // 服務還開著（WAL）也能備份
        const key = randomBytes(32);
        const r = await backup({ dbPath: dbFile, dir: join(dir, 'bk'), key });
        assert.match(r.file.split(/[\\/]/).pop(), BACKUP_RE);
        assert.equal(r.accounts, 1);
        const blob = readFileSync(r.file);
        for (const s of ['測試合成學生', 'argon2id', 'abc3456', 'SQLite format']) assert.ok(!blob.includes(Buffer.from(s)), `backup leaks ${s}`);
        assert.deepEqual(readdirSync(join(dir, 'bk')).filter(f => !BACKUP_RE.test(f)), [], 'no plaintext temp file left');
        db.close();
        const target = join(dir, 'restored.db');
        assert.equal(verify({ file: r.file, key, tmpDir: dir }).ok, true);
        const chk = restore({ file: r.file, target, key });
        assert.deepEqual([chk.ok, chk.version, chk.accounts], [true, 1, 1]);
        const back = openDb(target);
        assert.equal(back.prepare('SELECT username FROM student_accounts').get().username, 'abc3456');
        back.close();
        assert.throws(() => restore({ file: r.file, target, key }), /已存在/, 'refuses to overwrite without --force');
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖：暫存資料夾留給系統清理 */ } }
});

test('wrong key or tampered file is refused', () => {
    const key = randomBytes(32);
    const blob = encrypt(Buffer.from('hello'), key);
    assert.equal(decrypt(blob, key).toString(), 'hello');
    assert.throws(() => decrypt(blob, randomBytes(32)), /解密失敗/);
    const bad = Buffer.from(blob); bad[bad.length - 20] ^= 1;
    assert.throws(() => decrypt(bad, key), /解密失敗/);
    assert.throws(() => decrypt(Buffer.from('not a backup at all, definitely not'), key), /不是 FHES 備份檔/);
});

test('retention deletes only old backups that match the name pattern and always keeps the newest 3', () => {
    const dir = tmp();
    try {
        const old = Date.now() / 1000 - 60 * 86400;
        const names = ['fhes-student-20260901-030000.db.enc', 'fhes-student-20260902-030000.db.enc', 'fhes-student-20260903-030000.db.enc', 'fhes-student-20260904-030000.db.enc', 'fhes-student-20260905-030000.db.enc', 'other-file.db'];
        for (const n of names) { writeFileSync(join(dir, n), 'x'); utimesSync(join(dir, n), old, old); }
        const removed = prune({ dir, keepDays: 30 });
        assert.deepEqual(removed, names.slice(0, 2));
        assert.ok(existsSync(join(dir, 'other-file.db')));
        assert.equal(readdirSync(dir).filter(f => BACKUP_RE.test(f)).length, 3);
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖：暫存資料夾留給系統清理 */ } }
});
