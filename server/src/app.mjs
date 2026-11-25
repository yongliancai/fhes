// v6.2 學生系統最小 API（ADR-015～020）。buildApp() 只組裝，不監聽埠號；正式入口在 server/main.mjs。
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { verifyGoogleIdToken, IdTokenError } from '../../src/auth/id-token.js';
import { validateProjection, projectionHash } from '../../src/core/student-projection.js';
import { summarizeCare, nextSlot, isCareAction, DAILY_CARE_LIMIT, CARE_BADGES } from '../../src/core/care.js';
import { localDate } from '../../src/core/dates.js';
import { generateUsername, generateInitialPassword, hashPassword, verifyPassword, dummyVerify, passwordProblem, newToken, sha256 } from './passwords.mjs';

export const LIMITS = Object.freeze({
    studentIdleMs: 2 * 3600_000, studentAbsMs: 12 * 3600_000, teacherAbsMs: 8 * 3600_000,
    idTokenMaxAgeS: 600,
    userFailLock: 5, userLockBaseMs: 60_000, userLockMaxMs: 15 * 60_000,
    ipWindowMs: 15 * 60_000, ipFailLimit: 30, teacherIpFailLimit: 20,
    projectionBody: 2 * 1024 * 1024, defaultBody: 16 * 1024,
});
const STALE_SEEN_MS = 60_000;      // last_seen 最多每分鐘更新一次

const json = (reply, code, body) => reply.code(code).type('application/json; charset=utf-8').send(body);
const fail = (reply, code, error, message) => json(reply, code, { error, message });
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 沒有參數的 querystring：多帶任何欄位（例如 ?studentId=）都回 400 */
const NO_QUERY = { type: 'object', additionalProperties: false, properties: {} };
const KEY = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };

/**
 * @param {{ db, config: { clientId, teacherOrigins: string[], studentOrigins: string[], cookieSecure?: boolean, ipSalt: string, staticRoot?: string, logger?: boolean },
 *           jwks: () => Promise<{keys: object[]}>, now?: () => number }} opts
 *   jwks：取得 Google 公開金鑰（正式環境＝Google 的 JWKS；測試＝測試金鑰）。驗證本身永遠執行。
 */
export const buildApp = ({ db, config, jwks, now = () => Date.now() }) => {
    if (!config?.clientId) throw new Error('缺少 Google OAuth Client ID');
    if (!config.ipSalt || config.ipSalt.length < 16) throw new Error('ipSalt 至少 16 個字元');
    const cookieSecure = config.cookieSecure !== false;
    const COOKIE = cookieSecure ? '__Host-fhes_sid' : 'fhes_sid';
    const app = Fastify({
        logger: config.logger ?? false, bodyLimit: LIMITS.defaultBody, trustProxy: config.trustProxy ?? false,
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
        genReqId: () => randomUUID(),
    });
    app.register(cookie);

    // ------------------------------------------------------------ 共用：稽核、限流、session
    const ipHash = (req) => sha256(`${config.ipSalt}|${req.ip}`).slice(0, 24);
    const audit = (req, actorKind, actorId, action, target = null, detail = null) =>
        db.prepare('INSERT INTO audit_events (ts, actor_kind, actor_id, action, target, detail, ip_hash) VALUES (?,?,?,?,?,?,?)')
            .run(now(), actorKind, actorId, action, target, detail ? JSON.stringify(detail) : null, ipHash(req));

    const rlGet = (key) => db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
    /** 固定視窗計數（IP） */
    const ipFailures = (key) => { const r = rlGet(key); return r && now() - r.window_start < LIMITS.ipWindowMs ? r.count : 0; };
    const ipFail = (key) => {
        const r = rlGet(key); const t = now();
        if (!r || t - r.window_start >= LIMITS.ipWindowMs) db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start, last_at) VALUES (?,1,?,?)').run(key, t, t);
        else db.prepare('UPDATE rate_limits SET count = count + 1, last_at = ? WHERE key = ?').run(t, key);
    };
    /** 帳號鎖定：連續失敗 5 次起，鎖 1、2、4… 分鐘，最多 15 分鐘（不論帳號是否存在都計） */
    const userLockedFor = (key) => {
        const r = rlGet(key); if (!r || r.count < LIMITS.userFailLock) return 0;
        const dur = Math.min(LIMITS.userLockMaxMs, LIMITS.userLockBaseMs * 2 ** (r.count - LIMITS.userFailLock));
        return Math.max(0, r.last_at + dur - now());
    };
    const userFail = (key) => { const t = now(); const r = rlGet(key);
        if (!r) db.prepare('INSERT INTO rate_limits (key, count, window_start, last_at) VALUES (?,1,?,?)').run(key, t, t);
        else db.prepare('UPDATE rate_limits SET count = count + 1, last_at = ? WHERE key = ?').run(t, key); };
    const rlReset = (key) => db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);

    const createSession = (kind, subjectId, scope = 'full') => {
        const token = newToken(); const t = now();
        const csrf = kind === 'student' ? newToken() : null;
        const abs = kind === 'student' ? LIMITS.studentAbsMs : LIMITS.teacherAbsMs;
        db.prepare('INSERT INTO sessions (id_hash, kind, subject_id, scope, csrf, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(sha256(token), kind, subjectId, scope, csrf, t, t, t + abs);
        return { token, csrf, expiresAt: t + abs };
    };
    const revokeSession = (token) => token && db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(now(), sha256(token));
    const revokeAllOf = (kind, subjectId) => db.prepare('UPDATE sessions SET revoked_at = ? WHERE kind = ? AND subject_id = ? AND revoked_at IS NULL').run(now(), kind, subjectId);
    const liveSession = (token, kind) => {
        if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
        const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND kind = ?').get(sha256(token), kind);
        const t = now();
        if (!s || s.revoked_at || s.expires_at <= t) return null;
        if (kind === 'student' && t - s.last_seen > LIMITS.studentIdleMs) { revokeSession(token); return null; }
        if (t - s.last_seen > STALE_SEEN_MS) db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(t, s.id_hash);
        return s;
    };
    const setStudentCookie = (reply, token) => reply.setCookie(COOKIE, token, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/', maxAge: LIMITS.studentAbsMs / 1000 });
    const clearStudentCookie = (reply) => reply.clearCookie(COOKIE, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/' });

    // ------------------------------------------------------------ 安全標頭
    app.addHook('onSend', async (req, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Cross-Origin-Opener-Policy', 'same-origin');
        reply.header('Content-Security-Policy', CSP);
        if (cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
        if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
        return payload;
    });
    app.setErrorHandler((err, req, reply) => {
        if (err.validation) return fail(reply, 400, 'bad_request', '請求格式不正確');
        if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return fail(reply, 413, 'too_large', '資料太大');
        if (err.statusCode && err.statusCode < 500) return fail(reply, err.statusCode, 'bad_request', '請求格式不正確');
        req.log.error(err);
        return fail(reply, 500, 'server_error', '伺服器發生錯誤，請稍後再試');
    });
    app.setNotFoundHandler((req, reply) => fail(reply, 404, 'not_found', '找不到'));

    // ------------------------------------------------------------ 教師：CORS（只允許設定的教師來源；Bearer，不用 Cookie）
    const teacherOriginOk = (o) => (config.teacherOrigins || []).includes(o);
    app.addHook('onRequest', async (req, reply) => {
        if (!req.url.startsWith('/api/teacher/')) return;
        const origin = req.headers.origin;
        if (origin !== undefined && !teacherOriginOk(origin)) return fail(reply, 403, 'origin', '不允許的來源');
        if (origin) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
        if (req.method === 'OPTIONS') {
            reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT');
            reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            reply.header('Access-Control-Max-Age', '600');
            return reply.code(204).send();
        }
    });
    app.options('/api/teacher/*', async (req, reply) => reply.code(204).send());

    const requireTeacher = async (req, reply) => {
        const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
        const s = m && liveSession(m[1], 'teacher');
        if (!s) return fail(reply, 401, 'unauthenticated', '請重新登入');
        req.teacherId = s.subject_id; req.teacherToken = m[1];
    };
    /** 班級必須屬於這位教師；否則一律 404（不透露是否存在） */
    const ownClass = (req, reply) => {
        const c = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(req.params.classKey, req.teacherId);
        if (!c) { fail(reply, 404, 'not_found', '找不到這個班級'); return null; }
        return c;
    };

    // ------------------------------------------------------------ 學生：同源 Cookie + CSRF + Origin
    const studentOriginOk = (o) => (config.studentOrigins || []).includes(o);
    const loadStudent = (req) => {
        const s = liveSession(req.cookies?.[COOKIE], 'student');
        if (!s) return null;
        const a = db.prepare('SELECT * FROM student_accounts WHERE id = ?').get(s.subject_id);
        if (!a || a.status !== 'active') { revokeAllOf('student', s.subject_id); return null; }
        return { session: s, account: a };
    };
    const studentGuard = ({ write = false, allowPwChange = false } = {}) => async (req, reply) => {
        if (write && !studentOriginOk(req.headers.origin)) return fail(reply, 403, 'origin', '不允許的來源');
        const ctx = loadStudent(req);
        if (!ctx) { clearStudentCookie(reply); return fail(reply, 401, 'unauthenticated', '請重新登入'); }
        if (write && !safeEq(req.headers['x-fhes-csrf'], ctx.session.csrf)) return fail(reply, 403, 'csrf', '請重新整理頁面後再試');
        if (ctx.session.scope !== 'full' && !allowPwChange) return fail(reply, 403, 'password_change_required', '請先設定新密碼');
        req.student = ctx;
    };
    const myProjection = (a) => db.prepare('SELECT * FROM student_projections WHERE class_id = ? AND local_student_id = ?').get(a.class_id, a.local_student_id);

    // ============================================================ 教師 API
    app.post('/api/teacher/session', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['credential', 'nonce'], properties: { credential: { type: 'string', maxLength: 4096 }, nonce: { type: 'string', minLength: 8, maxLength: 128 } } } },
    }, async (req, reply) => {
        const ipKey = `tip:${ipHash(req)}`;
        if (ipFailures(ipKey) >= LIMITS.teacherIpFailLimit) return fail(reply, 429, 'rate_limited', '嘗試太多次，請稍後再試');
        const { credential, nonce } = req.body;
        let id;
        try {
            const opts = { clientId: config.clientId, nonce, now: now() };
            try { id = await verifyGoogleIdToken(credential, { ...opts, jwks: await jwks() }); }
            catch (e) { if (e instanceof IdTokenError && e.code === 'kid') id = await verifyGoogleIdToken(credential, { ...opts, jwks: await jwks(true) }); else throw e; }
            if (id.iat < now() - LIMITS.idTokenMaxAgeS * 1000) throw new IdTokenError('iat', '登入憑證太舊，請重新登入');
        } catch (e) {
            ipFail(ipKey);
            audit(req, 'anonymous', null, 'teacher.session.fail', null, { code: e instanceof IdTokenError ? e.code : 'error' });
            return fail(reply, 401, 'invalid_token', '無法驗證 Google 登入，請重新登入');
        }
        const tokenHash = sha256(credential);
        db.prepare('DELETE FROM used_id_tokens WHERE expires_at < ?').run(now());
        try { db.prepare('INSERT INTO used_id_tokens (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, id.exp + 120_000); }
        catch { ipFail(ipKey); return fail(reply, 401, 'replayed', '這個登入憑證已經用過，請重新登入'); }
        const accountHash = sha256(`https://accounts.google.com|${id.sub}`);
        let t = db.prepare('SELECT * FROM teachers WHERE account_hash = ?').get(accountHash);
        if (!t) { t = { id: `t_${newToken().slice(0, 16)}` }; db.prepare('INSERT INTO teachers (id, account_hash, created_at) VALUES (?,?,?)').run(t.id, accountHash, now()); }
        const s = createSession('teacher', t.id);
        audit(req, 'teacher', t.id, 'teacher.session');
        return json(reply, 200, { token: s.token, expiresAt: s.expiresAt });
    });

    app.post('/api/teacher/logout', { preHandler: requireTeacher }, async (req, reply) => {
        revokeSession(req.teacherToken); return json(reply, 200, { ok: true });
    });

    app.post('/api/teacher/classes', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['localClassId', 'name'], properties: { localClassId: { type: 'string', minLength: 1, maxLength: 64 }, name: { type: 'string', maxLength: 60 } } } },
    }, async (req, reply) => {
        const { localClassId, name } = req.body;
        let c = db.prepare('SELECT * FROM classes WHERE teacher_id = ? AND local_class_id = ?').get(req.teacherId, localClassId);
        if (!c) {
            c = { id: `c_${newToken().slice(0, 20)}` };
            db.prepare('INSERT INTO classes (id, teacher_id, local_class_id, name, created_at) VALUES (?,?,?,?,?)').run(c.id, req.teacherId, localClassId, name, now());
            audit(req, 'teacher', req.teacherId, 'class.link', c.id);
        } else db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, c.id);
        return json(reply, 200, { classKey: c.id });
    });

    const accountView = (a) => ({ accountId: a.id, localStudentId: a.local_student_id, username: a.username, status: a.status, mustChangePassword: !!a.must_change, lastLoginAt: a.last_login_at, createdAt: a.created_at });

    app.get('/api/teacher/classes/:classKey/accounts', { preHandler: requireTeacher, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const rows = db.prepare('SELECT * FROM student_accounts WHERE class_id = ? ORDER BY created_at, username').all(c.id);
        return json(reply, 200, { accounts: rows.map(accountView), publishedAt: c.published_at, version: c.projection_version });
    });

    app.post('/api/teacher/classes/:classKey/accounts', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['students'], properties: { students: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['localStudentId'], properties: { localStudentId: { type: 'string', minLength: 1, maxLength: 64 } } } } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const created = []; const existing = [];
        for (const { localStudentId } of req.body.students) {
            if (db.prepare('SELECT 1 FROM student_accounts WHERE class_id = ? AND local_student_id = ?').get(c.id, localStudentId)) { existing.push(localStudentId); continue; }
            const initialPassword = generateInitialPassword();
            const hash = await hashPassword(initialPassword);
            let username;
            for (let i = 0; i < 20; i++) { const u = generateUsername(); if (!db.prepare('SELECT 1 FROM student_accounts WHERE username = ?').get(u)) { username = u; break; } }
            if (!username) return fail(reply, 503, 'busy', '無法產生帳號，請再試一次');
            const id = `s_${newToken().slice(0, 20)}`; const t = now();
            try { db.prepare('INSERT INTO student_accounts (id, class_id, local_student_id, username, password_hash, must_change, status, created_at, updated_at) VALUES (?,?,?,?,?,1,\'active\',?,?)').run(id, c.id, localStudentId, username, hash, t, t); }
            catch { existing.push(localStudentId); continue; }                     // 同時建立：唯一鍵擋下第二筆
            created.push({ accountId: id, localStudentId, username, initialPassword });
        }
        audit(req, 'teacher', req.teacherId, 'account.create', c.id, { count: created.length });
        return json(reply, 200, { created, existing });
    });

    const teacherAccount = (req, reply) => {
        const c = ownClass(req, reply); if (!c) return null;
        const a = db.prepare('SELECT * FROM student_accounts WHERE id = ? AND class_id = ?').get(req.params.accountId, c.id);
        if (!a) { fail(reply, 404, 'not_found', '找不到這個帳號'); return null; }
        return a;
    };
    const NO_BODY = { type: 'object', additionalProperties: false, properties: {} };
    app.post('/api/teacher/classes/:classKey/accounts/:accountId/reset', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const a = teacherAccount(req, reply); if (!a) return;
        const initialPassword = generateInitialPassword();
        db.prepare('UPDATE student_accounts SET password_hash = ?, must_change = 1, updated_at = ? WHERE id = ?').run(await hashPassword(initialPassword), now(), a.id);
        revokeAllOf('student', a.id); rlReset(`user:${a.username}`);
        audit(req, 'teacher', req.teacherId, 'account.reset', a.id);
        return json(reply, 200, { accountId: a.id, username: a.username, initialPassword });
    });
    for (const [path, status] of [['disable', 'disabled'], ['enable', 'active']]) {
        app.post(`/api/teacher/classes/:classKey/accounts/:accountId/${path}`, { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
            const a = teacherAccount(req, reply); if (!a) return;
            db.prepare('UPDATE student_accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), a.id);
            if (status === 'disabled') revokeAllOf('student', a.id);
            audit(req, 'teacher', req.teacherId, `account.${path}`, a.id);
            return json(reply, 200, accountView({ ...a, status }));
        });
    }

    app.put('/api/teacher/classes/:classKey/projection', {
        preHandler: requireTeacher, bodyLimit: LIMITS.projectionBody,
        schema: { body: { type: 'object', additionalProperties: false, required: ['version', 'hash', 'projection'], properties: { version: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, projection: { type: 'object' } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const { version, hash, projection } = req.body;
        const errors = validateProjection(projection);
        if (errors.length) return json(reply, 400, { error: 'invalid_projection', message: '發布的資料格式不正確', details: errors.slice(0, 20) });
        if (await projectionHash(projection) !== hash) return fail(reply, 400, 'hash_mismatch', '資料雜湊不符');
        if (version < c.projection_version) return json(reply, 409, { error: 'stale', message: '已有較新的發布版本', currentVersion: c.projection_version });
        if (version === c.projection_version) {
            if (hash === c.projection_hash) return json(reply, 200, { version, publishedAt: c.published_at, unchanged: true });
            return json(reply, 409, { error: 'version_conflict', message: '同一版本的內容不同', currentVersion: c.projection_version });
        }
        const t = now();
        db.transaction(() => {
            const keepS = projection.students.map(s => s.studentId); const keepG = projection.groups.map(g => g.groupId);
            db.prepare(`DELETE FROM student_projections WHERE class_id = ? AND local_student_id NOT IN (SELECT value FROM json_each(?))`).run(c.id, JSON.stringify(keepS));
            db.prepare(`DELETE FROM group_projections WHERE class_id = ? AND group_id NOT IN (SELECT value FROM json_each(?))`).run(c.id, JSON.stringify(keepG));
            const upS = db.prepare('INSERT OR REPLACE INTO student_projections (class_id, local_student_id, group_id, data, version) VALUES (?,?,?,?,?)');
            for (const s of projection.students) upS.run(c.id, s.studentId, s.groupId, JSON.stringify(s), version);
            const upG = db.prepare('INSERT OR REPLACE INTO group_projections (class_id, group_id, data, version) VALUES (?,?,?,?)');
            for (const g of projection.groups) upG.run(c.id, g.groupId, JSON.stringify(g), version);
            db.prepare('UPDATE classes SET projection_version = ?, projection_hash = ?, published_at = ?, name = ?, name_mode = ? WHERE id = ?')
                .run(version, hash, t, projection.className, projection.nameMode, c.id);
        })();
        audit(req, 'teacher', req.teacherId, 'projection.publish', c.id, { version, students: projection.students.length });
        return json(reply, 200, { version, publishedAt: t, unchanged: false, students: projection.students.length, groups: projection.groups.length });
    });

    /** 小組照顧彙總（後端計算）：members＝目前投影中屬於這組、且帳號啟用的學生數 */
    const groupCare = (classId, group) => {
        const events = db.prepare('SELECT item_id AS itemId, account_id AS accountId, local_date AS localDate FROM group_care_events WHERE class_id = ? AND group_id = ? AND slot IS NOT NULL').all(classId, group.groupId);
        const members = db.prepare(`SELECT COUNT(*) AS n FROM student_projections p JOIN student_accounts a ON a.class_id = p.class_id AND a.local_student_id = p.local_student_id
            WHERE p.class_id = ? AND p.group_id = ? AND a.status = 'active'`).get(classId, group.groupId).n;
        return summarizeCare({ events, animalIds: group.animals.map(x => x.itemId), members, today: localDate(now()) });
    };

    app.get('/api/teacher/classes/:classKey/care-summary', { preHandler: requireTeacher, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const groups = db.prepare('SELECT data FROM group_projections WHERE class_id = ? ORDER BY group_id').all(c.id).map(r => JSON.parse(r.data));
        return json(reply, 200, { groups: groups.map(g => ({ groupId: g.groupId, name: g.name, care: groupCare(c.id, g) })) });
    });

    // ============================================================ 學生 API
    app.post('/api/student/login', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 32 }, password: { type: 'string', maxLength: 128 } } } },
    }, async (req, reply) => {
        if (!studentOriginOk(req.headers.origin)) return fail(reply, 403, 'origin', '不允許的來源');
        const ipKey = `ip:${ipHash(req)}`;
        if (ipFailures(ipKey) >= LIMITS.ipFailLimit) { reply.header('Retry-After', String(LIMITS.ipWindowMs / 1000)); return fail(reply, 429, 'rate_limited', '嘗試太多次，請過幾分鐘再試'); }
        const username = String(req.body.username).trim().toLowerCase();
        const userKey = `user:${username}`;
        const locked = userLockedFor(userKey);
        if (locked > 0) { reply.header('Retry-After', String(Math.ceil(locked / 1000))); return fail(reply, 429, 'rate_limited', '嘗試太多次，請過幾分鐘再試'); }
        const a = db.prepare('SELECT * FROM student_accounts WHERE username = ?').get(username);
        const ok = a ? await verifyPassword(a.password_hash, req.body.password) : await dummyVerify(req.body.password);
        if (!ok || a.status !== 'active') {
            ipFail(ipKey); userFail(userKey);
            audit(req, 'anonymous', null, 'student.login.fail');
            return fail(reply, 401, 'invalid_credentials', '帳號或密碼錯誤');
        }
        rlReset(userKey);
        revokeSession(req.cookies?.[COOKIE]);                                    // 防 session 固定：登入一定換新的
        const s = createSession('student', a.id, a.must_change ? 'pwchange' : 'full');
        db.prepare('UPDATE student_accounts SET last_login_at = ? WHERE id = ?').run(now(), a.id);
        db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?').run(now(), now() - 86400_000);
        audit(req, 'student', a.id, 'student.login');
        setStudentCookie(reply, s.token);
        return json(reply, 200, { mustChangePassword: !!a.must_change, csrf: s.csrf });
    });

    app.post('/api/student/logout', { preHandler: studentGuard({ write: true, allowPwChange: true }), schema: { body: NO_BODY } }, async (req, reply) => {
        revokeSession(req.cookies[COOKIE]); clearStudentCookie(reply);
        return json(reply, 200, { ok: true });
    });

    app.post('/api/student/password', {
        preHandler: studentGuard({ write: true, allowPwChange: true }),
        schema: { body: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', maxLength: 128 }, newPassword: { type: 'string', maxLength: 128 } } } },
    }, async (req, reply) => {
        const { account: a } = req.student;
        const userKey = `user:${a.username}`;
        if (userLockedFor(userKey) > 0) return fail(reply, 429, 'rate_limited', '嘗試太多次，請過幾分鐘再試');
        if (!await verifyPassword(a.password_hash, req.body.currentPassword)) { userFail(userKey); return fail(reply, 400, 'wrong_password', '目前的密碼不正確'); }
        const problem = passwordProblem(req.body.newPassword, { username: a.username });
        if (problem) return fail(reply, 400, 'weak_password', problem);
        if (await verifyPassword(a.password_hash, req.body.newPassword)) return fail(reply, 400, 'weak_password', '新密碼不能和目前的一樣');
        db.prepare('UPDATE student_accounts SET password_hash = ?, must_change = 0, updated_at = ? WHERE id = ?').run(await hashPassword(req.body.newPassword), now(), a.id);
        revokeAllOf('student', a.id);                                           // 其他裝置上的舊 Session 全部失效
        const s = createSession('student', a.id, 'full');
        audit(req, 'student', a.id, 'student.password');
        setStudentCookie(reply, s.token);
        return json(reply, 200, { ok: true, csrf: s.csrf });
    });

    app.get('/api/student/me', { preHandler: studentGuard({ allowPwChange: true }), schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const { account: a, session: s } = req.student;
        return json(reply, 200, { username: a.username, mustChangePassword: s.scope !== 'full', csrf: s.csrf });
    });

    const classInfo = (a) => db.prepare('SELECT name, published_at, projection_version FROM classes WHERE id = ?').get(a.class_id);

    app.get('/api/student/dashboard', { preHandler: studentGuard(), schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const { account: a } = req.student;
        const p = myProjection(a); const c = classInfo(a);
        if (!p) return json(reply, 200, { published: false, className: c.name });
        const me = JSON.parse(p.data);
        const g = me.groupId != null ? db.prepare('SELECT data FROM group_projections WHERE class_id = ? AND group_id = ?').get(a.class_id, me.groupId) : null;
        const group = g ? JSON.parse(g.data) : null;
        return json(reply, 200, {
            published: true, className: c.name, publishedAt: c.published_at,
            me: { name: me.name, seat: me.seat, score: me.score },
            group: group ? { groupId: group.groupId, name: group.name, xp: group.xp, animals: group.animals.length } : null,
            homeworkSummary: {
                total: me.homework.length,
                missing: me.homework.filter(h => h.submission === 'missing').length,
                needsCorrection: me.homework.filter(h => h.correction === 'needs').length,
            },
        });
    });

    app.get('/api/student/homework', { preHandler: studentGuard(), schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const { account: a } = req.student;
        const p = myProjection(a); const c = classInfo(a);
        if (!p) return json(reply, 200, { published: false, homework: [] });
        return json(reply, 200, { published: true, publishedAt: c.published_at, homework: JSON.parse(p.data).homework });
    });

    const zooView = (a) => {
        const p = myProjection(a); const c = classInfo(a);
        if (!p) return { published: false, group: null };
        const me = JSON.parse(p.data);
        const g = me.groupId != null ? db.prepare('SELECT data FROM group_projections WHERE class_id = ? AND group_id = ?').get(a.class_id, me.groupId) : null;
        if (!g) return { published: true, publishedAt: c.published_at, group: null };
        const group = JSON.parse(g.data);
        const used = db.prepare('SELECT COUNT(*) AS n FROM group_care_events WHERE account_id = ? AND local_date = ? AND slot IS NOT NULL').get(a.id, localDate(now())).n;
        return {
            published: true, publishedAt: c.published_at,
            group: { groupId: group.groupId, name: group.name, worldId: group.worldId, xp: group.xp, animals: group.animals },
            care: groupCare(a.class_id, group),
            badges: CARE_BADGES,
            myToday: { used, limit: DAILY_CARE_LIMIT },
        };
    };
    app.get('/api/student/zoo', { preHandler: studentGuard(), schema: { querystring: NO_QUERY } }, async (req, reply) => json(reply, 200, zooView(req.student.account)));

    app.post('/api/student/care', {
        preHandler: studentGuard({ write: true }),
        schema: { body: { type: 'object', additionalProperties: false, required: ['itemId', 'action', 'idempotencyKey'], properties: { itemId: { type: 'string', minLength: 1, maxLength: 64 }, action: { type: 'string', maxLength: 8 }, idempotencyKey: KEY } } },
    }, async (req, reply) => {
        const { account: a } = req.student;
        const { itemId, action, idempotencyKey } = req.body;
        if (!isCareAction(action)) return fail(reply, 400, 'bad_request', '不明的動作');
        const today = localDate(now());
        // 同步交易：檢查小組與動物、冪等、每日上限，一次完成（better-sqlite3 交易是同步的，不會和其他請求交錯）
        const result = db.transaction(() => {
            const prev = db.prepare('SELECT * FROM group_care_events WHERE account_id = ? AND idempotency_key = ?').get(a.id, idempotencyKey);
            if (prev) {
                if (prev.item_id !== itemId || prev.action !== action) return { code: 409, error: 'idempotency_conflict', message: '同一個操作代碼用在不同的動作' };
                return { code: 200, counted: prev.slot !== null, replay: true, groupId: prev.group_id };
            }
            const p = myProjection(a);
            const me = p ? JSON.parse(p.data) : null;
            if (!me || me.groupId == null) return { code: 409, error: 'no_group', message: '你還沒有小組' };
            const g = db.prepare('SELECT data FROM group_projections WHERE class_id = ? AND group_id = ?').get(a.class_id, me.groupId);
            const group = g ? JSON.parse(g.data) : null;
            if (!group || !group.animals.some(x => x.itemId === itemId)) return { code: 404, error: 'not_found', message: '你的小組沒有這隻動物' };
            const usedToday = db.prepare('SELECT COUNT(*) AS n FROM group_care_events WHERE account_id = ? AND local_date = ? AND slot IS NOT NULL').get(a.id, today).n;
            const slot = nextSlot(usedToday);
            db.prepare('INSERT INTO group_care_events (id, class_id, group_id, account_id, item_id, action, local_date, slot, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(`ce_${newToken().slice(0, 20)}`, a.class_id, me.groupId, a.id, itemId, action, today, slot, idempotencyKey, now());
            return { code: 200, counted: slot !== null, replay: false, groupId: me.groupId };
        }).immediate();
        if (result.code !== 200) return fail(reply, result.code, result.error, result.message);
        const view = zooView(a);
        return json(reply, 200, { counted: result.counted, replay: result.replay, myToday: view.myToday, animal: view.care?.animals?.[itemId] || null, care: view.care });
    });

    // ============================================================ 學生頁面（同源靜態檔，只開放白名單）
    if (config.staticRoot) {
        const root = resolve(config.staticRoot);
        const allowed = (p) => p === '/student.html' || /^\/src\/(core|data|art|student)\/[A-Za-z0-9_\-/]+\.(js|css)$/.test(p) || /^\/assets\/[A-Za-z0-9_\-/]+\.(webp|png|svg)$/.test(p);
        app.get('/', async (req, reply) => reply.redirect('/student.html'));
        app.get('/*', async (req, reply) => {
            const path = decodeURIComponent(req.url.split('?')[0]);
            if (path.includes('..') || !allowed(path)) return fail(reply, 404, 'not_found', '找不到');
            const file = resolve(root, `.${path}`);
            if (!file.startsWith(root + sep)) return fail(reply, 404, 'not_found', '找不到');
            try { const body = await readFile(file); return reply.code(200).type(STATIC_TYPES[extname(file)] || 'application/octet-stream').header('Cache-Control', 'no-cache').send(body); }
            catch { return fail(reply, 404, 'not_found', '找不到'); }
        });
    }

    return app;
};
