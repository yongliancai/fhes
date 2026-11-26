// 學生系統資料庫（better-sqlite3，單一檔案；測試用 ':memory:'）。ADR-016。
// 不存：明文密碼、session id 原文、教師 email 或 Google sub 原文。
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 2;

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
];

export const openDb = (file = ':memory:') => {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const v = db.pragma('user_version', { simple: true });
    for (let i = v; i < MIGRATIONS.length; i++) {
        db.transaction(() => { db.exec(MIGRATIONS[i]); db.pragma(`user_version = ${i + 1}`); })();
    }
    return db;
};
