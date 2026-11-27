// 學生系統資料庫（better-sqlite3，單一檔案；測試用 ':memory:'）。ADR-016。
// 不存：明文密碼、session id 原文、教師 email 或 Google sub 原文。
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 4;

const MIGRATIONS = [
    // v1
    `
    CREATE TABLE teachers (
        id TEXT PRIMARY KEY,
        account_hash TEXT NOT NULL UNIQUE,              -- SHA-256(iss|sub)，不存 sub／email
        created_at INTEGER NOT NULL
    );
    CREATE TABLE classes (
        id TEXT PRIMARY KEY,                            -- classKey（隨機）
        teacher_id TEXT NOT NULL REFERENCES teachers(id),
        local_class_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        projection_version INTEGER NOT NULL DEFAULT 0,
        projection_hash TEXT,
        published_at INTEGER,
        name_mode TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (teacher_id, local_class_id)
    );
    CREATE TABLE student_accounts (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id),
        local_student_id TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        last_login_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (class_id, local_student_id)
    );
    CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY,                       -- SHA-256(session token)
        kind TEXT NOT NULL CHECK (kind IN ('student', 'teacher')),
        subject_id TEXT NOT NULL,                       -- student_accounts.id 或 teachers.id
        scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'pwchange')),
        csrf TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
    );
    CREATE INDEX sessions_subject ON sessions (kind, subject_id);
    CREATE TABLE student_projections (
        class_id TEXT NOT NULL REFERENCES classes(id),
        local_student_id TEXT NOT NULL,
        group_id INTEGER,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (class_id, local_student_id)
    );
    CREATE TABLE group_projections (
        class_id TEXT NOT NULL REFERENCES classes(id),
        group_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (class_id, group_id)
    );
    CREATE TABLE group_care_events (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        account_id TEXT NOT NULL REFERENCES student_accounts(id),
        item_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('feed', 'pet')),
        local_date TEXT NOT NULL,
        slot INTEGER CHECK (slot IS NULL OR slot BETWEEN 1 AND 3),   -- 有效照顧才有 slot；每生每日最多 3
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (account_id, idempotency_key),
        UNIQUE (account_id, local_date, slot)
    );
    CREATE INDEX care_group ON group_care_events (class_id, group_id, slot);
    CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        ip_hash TEXT
    );
    CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,                           -- 'ip:<雜湊>'、'user:<帳號>'（不論帳號是否存在都計，避免列舉）
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        last_at INTEGER NOT NULL
    );
    CREATE TABLE used_id_tokens (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
    );
    `,
    // v2（v6.2 小老師）：老師指定的小老師可以登記全班作業；登記先存在這裡，教師端收取後轉成老師的作業事件
    `
    ALTER TABLE student_accounts ADD COLUMN is_helper INTEGER NOT NULL DEFAULT 0 CHECK (is_helper IN (0, 1));
    ALTER TABLE classes ADD COLUMN inbox_seq INTEGER NOT NULL DEFAULT 0;   -- 目前發布的投影已經包含到第幾筆登記
    CREATE TABLE hw_registrations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,          -- 教師端收取的游標
        id TEXT NOT NULL UNIQUE,
        class_id TEXT NOT NULL REFERENCES classes(id),
        helper_account_id TEXT NOT NULL REFERENCES student_accounts(id),
        helper_local_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        local_student_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('submitted', 'missing', 'needs', 'done')),
        local_date TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (helper_account_id, idempotency_key, local_student_id)
    );
    CREATE INDEX hwreg_class ON hw_registrations (class_id, seq);
    CREATE INDEX hwreg_helper_day ON hw_registrations (helper_account_id, local_date);
    `,
    // v3（ADR-024 多班級）：登入身分（users／帳密／Google）與「班級成員」分開。
    // student_accounts 就地重建成「某人在某班的成員資格」：表名與 id 保留，所以照顧紀錄（account_id）
    // 與小老師登記（helper_account_id）的外鍵和既有資料完全不用動，而且本來就是每班各自計算。
    // 帳密移到 password_credentials；舊帳號一人一個 user（u_s_ + 原 id 後段；老師是 u_t_），不依姓名／Email 合併任何帳號。
    { fkOff: true, sql: `
    CREATE TABLE users (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        provider TEXT NOT NULL CHECK (provider IN ('google')),
        subject_hash TEXT NOT NULL,                     -- SHA-256(iss|sub)，不存 sub／email 原文
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE (provider, subject_hash)
    );
    CREATE INDEX identities_user ON auth_identities (user_id);
    CREATE TABLE password_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0, 1)),
        issued_by_class_id TEXT REFERENCES classes(id),  -- 哪一班的老師發的（重設權限判斷用）
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    ALTER TABLE teachers ADD COLUMN user_id TEXT REFERENCES users(id);
    ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
    ALTER TABLE classes ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));

    CREATE TABLE student_accounts_v3 (
        id TEXT PRIMARY KEY,                            -- 舊 s_xxx 原樣保留
        class_id TEXT NOT NULL REFERENCES classes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        local_student_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'left', 'removed')),
        is_helper INTEGER NOT NULL DEFAULT 0 CHECK (is_helper IN (0, 1)),
        joined_via TEXT NOT NULL DEFAULT 'teacher' CHECK (joined_via IN ('teacher', 'claim', 'invite')),
        last_login_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (class_id, user_id)
    );
    INSERT INTO users (id, status, created_at, updated_at)
        SELECT 'u_s_' || substr(id, 3), 'active', created_at, updated_at FROM student_accounts;
    INSERT INTO password_credentials (user_id, username, password_hash, must_change, issued_by_class_id, created_at, updated_at)
        SELECT 'u_s_' || substr(id, 3), username, password_hash, must_change, class_id, created_at, updated_at FROM student_accounts;
    INSERT INTO student_accounts_v3 (id, class_id, user_id, local_student_id, status, is_helper, joined_via, last_login_at, created_at, updated_at)
        SELECT id, class_id, 'u_s_' || substr(id, 3), local_student_id, status, is_helper, 'teacher', last_login_at, created_at, updated_at FROM student_accounts;
    INSERT INTO users (id, status, created_at, updated_at) SELECT 'u_t_' || substr(id, 3), 'active', created_at, created_at FROM teachers;
    INSERT INTO auth_identities (id, user_id, provider, subject_hash, created_at)
        SELECT 'ai_t_' || substr(id, 3), 'u_t_' || substr(id, 3), 'google', account_hash, created_at FROM teachers;
    UPDATE teachers SET user_id = 'u_t_' || substr(id, 3);
    DROP TABLE student_accounts;
    ALTER TABLE student_accounts_v3 RENAME TO student_accounts;
    -- 同一班同一位本機學生只能綁一個「有效或停用中」的成員；退出／移除後可由老師再綁
    CREATE UNIQUE INDEX member_local ON student_accounts (class_id, local_student_id) WHERE status IN ('active', 'disabled');
    CREATE INDEX member_user ON student_accounts (user_id);
    -- 學生工作階段的主體從「帳號」改成 user：升級時全部登出（學生重新登入即可）
    UPDATE sessions SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE kind = 'student' AND revoked_at IS NULL;
    `, check: (db) => {
        const n = (q) => db.prepare(q).get().n;
        const members = n('SELECT COUNT(*) n FROM student_accounts');
        const creds = n('SELECT COUNT(*) n FROM password_credentials');
        const studentUsers = n("SELECT COUNT(*) n FROM users WHERE substr(id, 1, 4) = 'u_s_'");
        if (members !== creds || members !== studentUsers) throw new Error(`v3 對帳失敗：成員 ${members}、帳密 ${creds}、學生 user ${studentUsers}`);
        if (n('SELECT COUNT(*) n FROM teachers WHERE user_id IS NULL')) throw new Error('v3 對帳失敗：有老師沒有對應的 user');
    } },
    // v4（v6.2 多班級 P2）：教師自助註冊、班級邀請與加入申請、個別綁定碼、平台管理員與「重設密碼申請」（D3）。
    // 代碼一律只存 HMAC；學生自己填的名字只給老師參考，30 天後清掉（T33）。sessions 重建只是為了讓 kind 多一個 'admin'。
    `
    ALTER TABLE teachers ADD COLUMN signup TEXT NOT NULL DEFAULT 'allowlist' CHECK (signup IN ('allowlist', 'self'));
    -- D3：老師只能重發「還沒有人用它登入過」的帳密；以前登入過（或已經自己改過密碼）的都算用過
    ALTER TABLE password_credentials ADD COLUMN first_login_at INTEGER;
    UPDATE password_credentials SET first_login_at = COALESCE(
        (SELECT MAX(m.last_login_at) FROM student_accounts m WHERE m.user_id = password_credentials.user_id),
        CASE WHEN must_change = 0 THEN updated_at END);

    CREATE TABLE sessions_v4 (
        id_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('student', 'teacher', 'admin')),
        subject_id TEXT NOT NULL,                       -- 學生＝users.id；老師＝teachers.id；管理員＝users.id
        scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'pwchange')),
        csrf TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
    );
    INSERT INTO sessions_v4 (id_hash, kind, subject_id, scope, csrf, created_at, last_seen, expires_at, revoked_at)
        SELECT id_hash, kind, subject_id, scope, csrf, created_at, last_seen, expires_at, revoked_at FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_v4 RENAME TO sessions;
    CREATE INDEX sessions_subject ON sessions (kind, subject_id);

    CREATE TABLE class_invitations (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id),
        code_hash TEXT NOT NULL UNIQUE,                 -- HMAC；代碼原文只在建立時回傳一次
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 200),
        used_count INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER
    );
    CREATE INDEX invitations_class ON class_invitations (class_id);
    CREATE TABLE join_requests (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        invitation_id TEXT REFERENCES class_invitations(id),
        display_name TEXT NOT NULL,                     -- 學生自己填（≤20 字），只給老師參考、不可信；30 天後清空
        seat_hint INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
        member_id TEXT REFERENCES student_accounts(id),
        created_at INTEGER NOT NULL,
        decided_at INTEGER
    );
    CREATE UNIQUE INDEX join_pending ON join_requests (class_id, user_id) WHERE status = 'pending';
    CREATE INDEX join_class ON join_requests (class_id, status);
    CREATE TABLE claim_codes (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id),
        local_student_id TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by_user_id TEXT REFERENCES users(id),
        revoked_at INTEGER
    );
    CREATE INDEX claim_class ON claim_codes (class_id, local_student_id);
    CREATE TABLE platform_admins (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),   -- 之後才加學校管理員（要先設計學校範圍）
        scope TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE password_reset_requests (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES student_accounts(id),
        requested_by TEXT NOT NULL REFERENCES teachers(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT REFERENCES users(id)
    );
    CREATE UNIQUE INDEX reset_pending ON password_reset_requests (member_id) WHERE status = 'pending';
    `,
];

export class SchemaTooNewError extends Error {}

/**
 * 依序執行尚未套用的 migration（每一步一個交易：失敗就整步回滾，資料庫維持原本的版本）。
 * fkOff 的步驟（要重建被外鍵參照的資料表）：交易外關閉外鍵檢查，交易內做完後 foreign_key_check 必須沒有問題、
 * 對帳（check）通過才 COMMIT；最後一定把外鍵檢查打開。
 * 資料庫版本比程式新（例如升級後又換回舊版程式）：拒絕開啟，避免舊程式寫壞新格式的資料。
 */
export const migrate = (db, migrations = MIGRATIONS) => {
    const v = db.pragma('user_version', { simple: true });
    if (v > migrations.length) throw new SchemaTooNewError(`資料庫版本 ${v} 比程式支援的 ${migrations.length} 新：請使用較新的程式，或還原升級前的備份`);
    for (let i = v; i < migrations.length; i++) {
        const m = typeof migrations[i] === 'string' ? { sql: migrations[i] } : migrations[i];
        if (m.fkOff) db.pragma('foreign_keys = OFF');
        try {
            db.transaction(() => {
                db.exec(m.sql);
                if (m.fkOff) { const bad = db.pragma('foreign_key_check'); if (bad.length) throw new Error(`migration v${i + 1} 外鍵檢查失敗：${JSON.stringify(bad.slice(0, 5))}`); }
                m.check?.(db);
                db.pragma(`user_version = ${i + 1}`);
            })();
        } finally { if (m.fkOff) db.pragma('foreign_keys = ON'); }
    }
};
/** 測試用：只套用前 n 個 migration（建立舊版資料庫） */
export const migrationsUpTo = (n) => MIGRATIONS.slice(0, n);

export const openDb = (file = ':memory:', { upTo } = {}) => {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    try { migrate(db, upTo ? migrationsUpTo(upTo) : MIGRATIONS); } catch (e) { db.close(); throw e; }
    return db;
};
