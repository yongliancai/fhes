// v6.2 學生系統最小 API（ADR-015～020）。buildApp() 只組裝，不監聽埠號；正式入口在 server/main.mjs。
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, randomUUID, createHmac } from 'node:crypto';
import { verifyGoogleIdToken, IdTokenError } from '../../src/auth/id-token.js';
import { validateProjection, projectionHash } from '../../src/core/student-projection.js';
import { summarizeCare, nextSlot, isCareAction, DAILY_CARE_LIMIT, CARE_BADGES } from '../../src/core/care.js';
import { localDate } from '../../src/core/dates.js';
import { simpleOf, isSimpleState } from '../../src/core/homework.js';
import { generateUsername, generateInitialPassword, generateCode, normalizeCode, hashPassword, verifyPassword, dummyVerify, passwordProblem, newToken, sha256 } from './passwords.mjs';

export const LIMITS = Object.freeze({
    studentIdleMs: 2 * 3600_000, studentAbsMs: 12 * 3600_000, teacherAbsMs: 8 * 3600_000,
    idTokenMaxAgeS: 600,
    userFailLock: 5, userLockBaseMs: 60_000, userLockMaxMs: 15 * 60_000,
    ipWindowMs: 15 * 60_000, ipFailLimit: 200, teacherIpFailLimit: 20,
    classesPerTeacher: 30, accountsPerClass: 80, uncountedCarePerDay: 30,
    projectionBody: 2 * 1024 * 1024, defaultBody: 16 * 1024,
    helperRowsPerDay: 3000, inboxPage: 500, inboxKeepDays: 120,
    // P2：自助開班、邀請、申請、綁定碼、管理員（docs/V62-MULTICLASS-DESIGN.md §7）
    classesPerDay: 10, invitesPerClass: 3, inviteDefaultDays: 7, inviteMaxDays: 30, inviteDefaultUses: 60,
    pendingPerClass: 100, codeUserFails: 10, codeIpFails: 50, claimDays: 30, joinKeepDays: 30,
    adminAbsMs: 4 * 3600_000, resetRequestDays: 14, auditPage: 200,
});
const DAY = 86400_000;
const STALE_SEEN_MS = 60_000;      // last_seen 最多每分鐘更新一次

const json = (reply, code, body) => reply.code(code).type('application/json; charset=utf-8').send(body);
const fail = (reply, code, error, message) => json(reply, code, { error, message });
const safeEq = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a); const y = Buffer.from(b);                 // 比較位元組長度（非 ASCII 字元不會讓 timingSafeEqual 丟例外，BUG-024）
    return x.length === y.length && timingSafeEqual(x, y);
};

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 沒有參數的 querystring：多帶任何欄位（例如 ?studentId=）都回 400 */
const NO_QUERY = { type: 'object', additionalProperties: false, properties: {} };
const KEY = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
/**
 * 學生端路徑上的「我在這一班的代號」（v3 多班級）＝自己的成員 id。只是「選哪一班」，權限一律由後端核對這個成員屬於登入的人。
 * 刻意不用教師端的 classKey：學生端的回應從來不含 classKey（縱深防禦，見 server-student 測試）。
 */
const MEMBER_PARAMS = { type: 'object', additionalProperties: false, required: ['memberId'], properties: { memberId: { type: 'string', pattern: '^s_[A-Za-z0-9_-]{8,64}$' } } };

/**
 * @param {{ db, config: { clientId, teacherOrigins: string[], studentOrigins: string[], cookieSecure?: boolean, ipSalt: string, staticRoot?: string, logger?: boolean,
 *           teacherSignup?: 'allowlist'|'open', teacherAllow?: string[], adminEmails?: string[], adminOrigins?: string[], codePepper?: string },
 *           jwks: () => Promise<{keys: object[]}>, now?: () => number, https?: { key, cert } }} opts
 *   jwks：取得 Google 公開金鑰（正式環境＝Google 的 JWKS；測試＝測試金鑰）。驗證本身永遠執行。
 *   https：選用。正式環境由反向代理處理 TLS（不用）；E2E 用自簽憑證，讓 Secure Cookie 在每個瀏覽器都有效。
 */
export const buildApp = ({ db, config, jwks, now = () => Date.now(), https }) => {
    if (!config?.clientId) throw new Error('缺少 Google OAuth Client ID');
    if (!config.ipSalt || config.ipSalt.length < 16) throw new Error('ipSalt 至少 16 個字元');
    const signupMode = config.teacherSignup ?? 'allowlist';
    if (!['allowlist', 'open'].includes(signupMode)) throw new Error('teacherSignup 只能是 allowlist 或 open');
    const cookieSecure = config.cookieSecure !== false;
    const COOKIE = cookieSecure ? '__Host-fhes_sid' : 'fhes_sid';
    const app = Fastify({
        logger: config.logger ?? false, bodyLimit: LIMITS.defaultBody, trustProxy: config.trustProxy ?? false,
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
        genReqId: () => randomUUID(),
        ...(https ? { https } : {}),
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
    const ipUndo = (key) => db.prepare('UPDATE rate_limits SET count = MAX(0, count - 1) WHERE key = ?').run(key);
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
        const abs = { student: LIMITS.studentAbsMs, teacher: LIMITS.teacherAbsMs, admin: LIMITS.adminAbsMs }[kind];
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

    // ------------------------------------------------------------ 教師與管理員：CORS（只允許設定的來源；Bearer，不用 Cookie）
    const teacherOriginOk = (o) => (config.teacherOrigins || []).includes(o);
    const adminOriginOk = (o) => (config.adminOrigins || config.teacherOrigins || []).includes(o);
    // BUG-022：allowlist 模式（預設）只有名單上的老師（完整 email 或 @網域）可以使用。
    // open 模式（D5，FHES_TEACHER_SIGNUP=open）：任何 email 已驗證的 Google 帳號都可以自助註冊成老師；靠限流、停權、稽核管理（T29）。
    // 兩種模式都要求 email_verified；老師只拿得到自己開的班，Email 或網域不會帶來任何別人班級的權限。
    const allow = (config.teacherAllow || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
    const onAllowlist = (id) => {
        const email = String(id.email || '').toLowerCase();
        return !!email && allow.some(a => a.startsWith('@') ? email.endsWith(a) : email === a);
    };
    const teacherAllowed = (id) => !!id.emailVerified && !!id.email && (signupMode === 'open' || onAllowlist(id));
    const adminEmails = (config.adminEmails || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
    app.addHook('onRequest', async (req, reply) => {
        const isTeacher = req.url.startsWith('/api/teacher/'); const isAdmin = req.url.startsWith('/api/admin/');
        if (!isTeacher && !isAdmin) return;
        const origin = req.headers.origin;
        if (origin !== undefined && !(isAdmin ? adminOriginOk(origin) : teacherOriginOk(origin))) return fail(reply, 403, 'origin', '不允許的來源');
        if (origin) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Vary', 'Origin'); }
        if (req.method === 'OPTIONS') {
            reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT');
            reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            reply.header('Access-Control-Max-Age', '600');
            return reply.code(204).send();
        }
    });
    app.options('/api/teacher/*', async (req, reply) => reply.code(204).send());
    app.options('/api/admin/*', async (req, reply) => reply.code(204).send());

    /** Google ID token：驗簽、aud、iss、nonce、時效（找不到 kid 時強制重抓一次金鑰）。失敗丟 IdTokenError */
    const verifyIdToken = async (credential, nonce) => {
        const opts = { clientId: config.clientId, nonce, now: now() };
        let id;
        try { id = await verifyGoogleIdToken(credential, { ...opts, jwks: await jwks() }); }
        catch (e) { if (e instanceof IdTokenError && e.code === 'kid') id = await verifyGoogleIdToken(credential, { ...opts, jwks: await jwks(true) }); else throw e; }
        if (id.iat < now() - LIMITS.idTokenMaxAgeS * 1000) throw new IdTokenError('iat', '登入憑證太舊，請重新登入');
        return id;
    };
    /** BUG-023 防重放：以「簽章涵蓋的內容」（header.payload）為鍵；同一張 token 不論用在老師或管理員登入都只能用一次 */
    const consumeIdToken = (credential, id) => {
        const tokenHash = sha256(credential.split('.').slice(0, 2).join('.'));
        db.prepare('DELETE FROM used_id_tokens WHERE expires_at < ?').run(now());
        try { db.prepare('INSERT INTO used_id_tokens (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, id.exp + 120_000); return true; }
        catch { return false; }
    };
    /** 同一個 Google 身分只會有一個 user（不依 Email 合併）；沒有就建立。要在交易內呼叫 */
    const userForIdentity = (subjectHash, t) => {
        const ident = db.prepare("SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject_hash = ?").get(subjectHash);
        if (ident) return ident.user_id;
        const userId = `u_${newToken().slice(0, 20)}`;
        db.prepare("INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(userId, t, t);
        db.prepare("INSERT INTO auth_identities (id, user_id, provider, subject_hash, created_at) VALUES (?, ?, 'google', ?, ?)").run(`ai_${newToken().slice(0, 20)}`, userId, subjectHash, t);
        return userId;
    };

    // 邀請碼／綁定碼只存 HMAC（金鑰和 IP 雜湊的鹽分開推導；也可以用 codePepper 另外指定）
    const codeKey = sha256(`fhes-code-v1|${config.codePepper || config.ipSalt}`);
    const codeHash = (code) => createHmac('sha256', codeKey).update(code).digest('hex');
    /** 輸入代碼錯誤的限流：每個 user 10 次、每個 IP 50 次／15 分鐘（T26） */
    const codeKeys = (req, userId) => [`code-u:${userId}`, `code-ip:${ipHash(req)}`];
    const codeLimited = (req, userId) => { const [u, i] = codeKeys(req, userId); return ipFailures(u) >= LIMITS.codeUserFails || ipFailures(i) >= LIMITS.codeIpFails; };
    const codeFail = (req, userId) => codeKeys(req, userId).forEach(ipFail);
    /** 學生自己填的名字：去掉控制字元與方向控制字元、壓縮空白，1～20 個字 */
    const cleanName = (s) => {
        // eslint-disable-next-line no-control-regex
        const v = String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
        const n = [...v].length;
        return n >= 1 && n <= 20 ? v : null;
    };

    const requireTeacher = async (req, reply) => {
        const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
        const s = m && liveSession(m[1], 'teacher');
        if (!s) return fail(reply, 401, 'unauthenticated', '請重新登入');
        // 停權立即生效（不必等工作階段過期）
        if (db.prepare('SELECT status FROM teachers WHERE id = ?').get(s.subject_id)?.status !== 'active') { revokeSession(m[1]); return fail(reply, 401, 'unauthenticated', '請重新登入'); }
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
    /** v3：一個 user 可以是多個班級的成員；這裡只列「有效」的成員資格（班級也要是有效的） */
    const activeMembers = (userId) => db.prepare(`SELECT m.*, c.name AS class_name FROM student_accounts m JOIN classes c ON c.id = m.class_id
        WHERE m.user_id = ? AND m.status = 'active' AND c.status = 'active' ORDER BY m.created_at, m.id`).all(userId);
    /**
     * 能不能登入／繼續使用：帳號必須啟用；如果這個人在某些班是「有效或停用中」，其中至少要有一個仍然有效。
     * （和 v6.2 相同：唯一的班級被老師停用 → 不能登入、已登入的立刻失效。
     *  已經退出或被移出的班不算：沒有任何班級的人仍可登入，只能用邀請碼或綁定碼加入班級，看不到任何班級資料）
     */
    const canUse = (u) => {
        if (!u || u.status !== 'active') return false;
        const r = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(m.status = 'active' AND c.status = 'active'), 0) AS live FROM student_accounts m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? AND m.status IN ('active', 'disabled')").get(u.id);
        return r.total === 0 || r.live > 0;
    };
    const loadStudent = (req) => {
        const s = liveSession(req.cookies?.[COOKIE], 'student');
        if (!s) return null;
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.subject_id);
        if (!canUse(u)) { revokeAllOf('student', s.subject_id); return null; }
        const cred = db.prepare('SELECT * FROM password_credentials WHERE user_id = ?').get(u.id) || null;
        return { session: s, user: u, cred };
    };
    const studentGuard = ({ write = false, allowPwChange = false } = {}) => async (req, reply) => {
        if (write && !studentOriginOk(req.headers.origin)) return fail(reply, 403, 'origin', '不允許的來源');
        const ctx = loadStudent(req);
        if (!ctx) { clearStudentCookie(reply); return fail(reply, 401, 'unauthenticated', '請重新登入'); }
        if (write && !safeEq(req.headers['x-fhes-csrf'], ctx.session.csrf)) return fail(reply, 403, 'csrf', '請重新整理頁面後再試');
        if (ctx.session.scope !== 'full' && !allowPwChange) return fail(reply, 403, 'password_change_required', '請先設定新密碼');
        req.student = ctx;
    };
    /**
     * 決定這個請求是「哪一班的哪一位學生」（ADR-027）：
     * - 路徑有 :memberId → 必須是這個 user 自己、而且仍然有效的成員資格；否則一律 404（不透露是否存在）。
     * - 舊路徑（沒有 classKey）→ 只有一個有效班級時照舊；多個班級要求先選班（409），不會默默用第一班。
     * 學生端永遠不接受前端送來的 studentId／localStudentId／groupId。
     */
    const withMember = async (req, reply) => {
        const userId = req.student.user.id;
        if (req.params?.memberId !== undefined) {
            const m = db.prepare(`SELECT m.* FROM student_accounts m JOIN classes c ON c.id = m.class_id
                WHERE m.id = ? AND m.user_id = ? AND m.status = 'active' AND c.status = 'active'`).get(req.params.memberId, userId);
            if (!m) return fail(reply, 404, 'not_found', '找不到這個班級');
            req.student.account = m; return;
        }
        const list = activeMembers(userId);
        if (list.length === 1) { req.student.account = list[0]; return; }
        if (!list.length) return fail(reply, 404, 'no_class', '你還沒有加入任何班級');
        return fail(reply, 409, 'choose_class', '你在好幾個班級，請先選擇班級');
    };
    /** 同一個處理函式同時掛在舊路徑與 /api/student/classes/:memberId/… */
    const studentRoute = (method, sub, { write = false, schema = {} }, handler) => {
        const guard = studentGuard({ write });
        app.route({ method, url: `/api/student/${sub}`, preHandler: [guard, withMember], schema, handler });
        app.route({ method, url: `/api/student/classes/:memberId/${sub}`, preHandler: [guard, withMember], schema: { ...schema, params: MEMBER_PARAMS }, handler });
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
        try { id = await verifyIdToken(credential, nonce); }
        catch (e) {
            ipFail(ipKey);
            audit(req, 'anonymous', null, 'teacher.session.fail', null, { code: e instanceof IdTokenError ? e.code : 'error' });
            return fail(reply, 401, 'invalid_token', '無法驗證 Google 登入，請重新登入');
        }
        if (!teacherAllowed(id)) {
            ipFail(ipKey);
            audit(req, 'anonymous', null, 'teacher.session.denied');
            return fail(reply, 403, 'not_allowed', '這個 Google 帳號沒有使用學生系統的權限，請聯絡管理者');
        }
        if (!consumeIdToken(credential, id)) { ipFail(ipKey); return fail(reply, 401, 'replayed', '這個登入憑證已經用過，請重新登入'); }
        const accountHash = sha256(`https://accounts.google.com|${id.sub}`);
        let t = db.prepare('SELECT * FROM teachers WHERE account_hash = ?').get(accountHash);
        if (!t) {
            // v3：老師也是平台 user（同一個 Google 身分只會有一個 user；不依 Email 合併）。signup 記錄是名單內還是自助註冊
            t = { id: `t_${newToken().slice(0, 16)}`, status: 'active' };
            const tt = now(); const signup = onAllowlist(id) ? 'allowlist' : 'self';
            db.transaction(() => {
                db.prepare('INSERT INTO teachers (id, account_hash, created_at, user_id, signup) VALUES (?,?,?,?,?)').run(t.id, accountHash, tt, userForIdentity(accountHash, tt), signup);
            }).immediate();
            audit(req, 'teacher', t.id, 'teacher.signup', null, { signup });
        }
        if (t.status === 'suspended') {
            audit(req, 'teacher', t.id, 'teacher.session.suspended');
            return fail(reply, 403, 'suspended', '這個老師帳號已被停用，請聯絡管理者');
        }
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
            if (db.prepare('SELECT COUNT(*) n FROM classes WHERE teacher_id = ?').get(req.teacherId).n >= LIMITS.classesPerTeacher) return fail(reply, 409, 'quota', `每位老師最多 ${LIMITS.classesPerTeacher} 個班級`);
            if (db.prepare('SELECT COUNT(*) n FROM classes WHERE teacher_id = ? AND created_at > ?').get(req.teacherId, now() - DAY).n >= LIMITS.classesPerDay) return fail(reply, 429, 'rate_limited', `每位老師一天最多連結 ${LIMITS.classesPerDay} 個新班級，請明天再試`);
            c = { id: `c_${newToken().slice(0, 20)}` };
            db.prepare('INSERT INTO classes (id, teacher_id, local_class_id, name, created_at) VALUES (?,?,?,?,?)').run(c.id, req.teacherId, localClassId, name, now());
            audit(req, 'teacher', req.teacherId, 'class.link', c.id);
        } else db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, c.id);
        return json(reply, 200, { classKey: c.id });
    });

    // username 只在帳密是「本班發的」時才有（別班老師發的帳號名稱不給這一班的老師看）。
    // signedInBefore：這組帳密有人登入過 → 老師不能重設，只能送「重設申請」給管理員（D3）
    const accountView = (a) => ({ accountId: a.id, localStudentId: a.local_student_id, username: a.username ?? null, status: a.status, mustChangePassword: !!a.must_change, helper: !!a.is_helper,
        lastLoginAt: a.last_login_at, createdAt: a.created_at, joinedVia: a.joined_via, signedInBefore: a.username ? !!a.first_login_at : null });

    /** 班級成員＋（如果有）本班發的帳密。移除／退出的成員不列出 */
    const MEMBER_SELECT = `SELECT m.*, p.username, p.must_change, p.issued_by_class_id, p.first_login_at FROM student_accounts m LEFT JOIN password_credentials p ON p.user_id = m.user_id AND p.issued_by_class_id = m.class_id`;
    app.get('/api/teacher/classes/:classKey/accounts', { preHandler: requireTeacher, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const rows = db.prepare(`${MEMBER_SELECT} WHERE m.class_id = ? AND m.status IN ('active', 'disabled') ORDER BY m.created_at, p.username`).all(c.id);
        return json(reply, 200, { accounts: rows.map(accountView), publishedAt: c.published_at, version: c.projection_version });
    });

    app.post('/api/teacher/classes/:classKey/accounts', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['students'], properties: { students: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['localStudentId'], properties: { localStudentId: { type: 'string', minLength: 1, maxLength: 64 } } } } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const created = []; const existing = [];
        const bound = (id) => db.prepare("SELECT 1 FROM student_accounts WHERE class_id = ? AND local_student_id = ? AND status IN ('active', 'disabled')").get(c.id, id);
        const have = db.prepare("SELECT COUNT(*) n FROM student_accounts WHERE class_id = ? AND status IN ('active', 'disabled')").get(c.id).n;
        const fresh = new Set(req.body.students.map(x => x.localStudentId).filter(id => !bound(id)));
        if (have + fresh.size > LIMITS.accountsPerClass) return fail(reply, 409, 'quota', `每個班級最多 ${LIMITS.accountsPerClass} 個學生帳號`);
        for (const { localStudentId } of req.body.students) {
            if (bound(localStudentId)) { existing.push(localStudentId); continue; }
            const initialPassword = generateInitialPassword();
            const hash = await hashPassword(initialPassword);
            let username;
            for (let i = 0; i < 20; i++) { const u = generateUsername(); if (!db.prepare('SELECT 1 FROM password_credentials WHERE username = ?').get(u)) { username = u; break; } }
            if (!username) return fail(reply, 503, 'busy', '無法產生帳號，請再試一次');
            const id = `s_${newToken().slice(0, 20)}`; const userId = `u_${newToken().slice(0, 20)}`; const t = now();
            // 老師發的帳號＝新的平台 user＋本班發的帳密＋本班成員資格（同一個交易）
            try {
                db.transaction(() => {
                    db.prepare("INSERT INTO users (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(userId, t, t);
                    db.prepare('INSERT INTO password_credentials (user_id, username, password_hash, must_change, issued_by_class_id, created_at, updated_at) VALUES (?,?,?,1,?,?,?)').run(userId, username, hash, c.id, t, t);
                    db.prepare("INSERT INTO student_accounts (id, class_id, user_id, local_student_id, status, is_helper, joined_via, created_at, updated_at) VALUES (?,?,?,?,'active',0,'teacher',?,?)").run(id, c.id, userId, localStudentId, t, t);
                }).immediate();
            } catch { existing.push(localStudentId); continue; }                     // 同時建立：唯一鍵擋下第二筆
            created.push({ accountId: id, localStudentId, username, initialPassword });
        }
        audit(req, 'teacher', req.teacherId, 'account.create', c.id, { count: created.length });
        return json(reply, 200, { created, existing });
    });

    const teacherAccount = (req, reply) => {
        const c = ownClass(req, reply); if (!c) return null;
        const a = db.prepare(`${MEMBER_SELECT} WHERE m.id = ? AND m.class_id = ? AND m.status IN ('active', 'disabled')`).get(req.params.accountId, c.id);
        if (!a) { fail(reply, 404, 'not_found', '找不到這個帳號'); return null; }
        return a;
    };
    /** 這個 user 是否也在「別位老師」的班上（有效或停用中）：是的話，本班老師不能重設他的密碼（D3，避免接管別班） */
    const inOtherTeachersClass = (userId, teacherId) => db.prepare(`SELECT COUNT(*) AS n FROM student_accounts m JOIN classes c ON c.id = m.class_id
        WHERE m.user_id = ? AND c.teacher_id <> ? AND m.status IN ('active', 'disabled')`).get(userId, teacherId).n > 0;
    /** 除了這一班，這個 user 還有沒有其他有效的成員資格 */
    const otherLiveMemberships = (userId, memberId) => db.prepare(`SELECT COUNT(*) AS n FROM student_accounts m JOIN classes c ON c.id = m.class_id
        WHERE m.user_id = ? AND m.id <> ? AND m.status = 'active' AND c.status = 'active'`).get(userId, memberId).n;
    const NO_BODY = { type: 'object', additionalProperties: false, properties: {} };
    app.post('/api/teacher/classes/:classKey/accounts/:accountId/reset', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const a = teacherAccount(req, reply); if (!a) return;
        // D3：老師只能「重發」本班發的、而且還沒有人用它登入過的帳密（例如帳號單弄丟了）。
        // 學生登入過之後，密碼只有學生自己能改；忘記密碼要由老師送出重設申請、管理員核准。
        // 也不能在別位老師的班上（否則等於可以登入看別班的資料）
        if (!a.username || a.issued_by_class_id !== a.class_id) return fail(reply, 403, 'not_issuer', '這個帳號不是本班發的，不能在這裡重設密碼');
        if (inOtherTeachersClass(a.user_id, req.teacherId)) return fail(reply, 403, 'other_teacher', '這位學生也在其他老師的班級，不能由老師重設密碼');
        if (a.first_login_at) return fail(reply, 403, 'already_used', '學生已經登入過，老師不能重設密碼；請改用「送出重設申請」，由管理員核准');
        const initialPassword = generateInitialPassword();
        // 條件式更新：檢查與寫入之間學生剛好第一次登入 → 不重設
        const r = db.prepare('UPDATE password_credentials SET password_hash = ?, must_change = 1, updated_at = ? WHERE user_id = ? AND first_login_at IS NULL').run(await hashPassword(initialPassword), now(), a.user_id);
        if (!r.changes) return fail(reply, 403, 'already_used', '學生已經登入過，老師不能重設密碼；請改用「送出重設申請」，由管理員核准');
        revokeAllOf('student', a.user_id); rlReset(`user:${a.username}`);
        audit(req, 'teacher', req.teacherId, 'account.reset', a.id);
        return json(reply, 200, { accountId: a.id, username: a.username, initialPassword });
    });
    // 忘記密碼（D3）：老師替本班學生向管理員送出申請；只記成員 id 和老師，不帶任何其他個資。同一位學生同時只有一筆待審
    app.post('/api/teacher/classes/:classKey/accounts/:accountId/reset-request', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const a = teacherAccount(req, reply); if (!a) return;
        if (!db.prepare('SELECT 1 FROM password_credentials WHERE user_id = ?').get(a.user_id)) return fail(reply, 400, 'no_password', '這位學生沒有帳號密碼，不需要重設');
        const prev = db.prepare("SELECT id FROM password_reset_requests WHERE member_id = ? AND status = 'pending'").get(a.id);
        if (prev) return json(reply, 200, { requestId: prev.id, status: 'pending', replay: true });
        const id = `rr_${newToken().slice(0, 20)}`;
        try { db.prepare("INSERT INTO password_reset_requests (id, member_id, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, a.id, req.teacherId, now()); }
        catch { return json(reply, 200, { requestId: db.prepare("SELECT id FROM password_reset_requests WHERE member_id = ? AND status = 'pending'").get(a.id)?.id, status: 'pending', replay: true }); }
        audit(req, 'teacher', req.teacherId, 'reset.request', a.id);
        return json(reply, 200, { requestId: id, status: 'pending', replay: false });
    });
    // 移出本班：成員資格立即失效（下一個請求就 404），user、帳密和他在別班的資料都不受影響；之後可以重新邀請或綁定
    app.post('/api/teacher/classes/:classKey/accounts/:accountId/remove', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const a = teacherAccount(req, reply); if (!a) return;
        db.transaction(() => {
            db.prepare("UPDATE student_accounts SET status = 'removed', is_helper = 0, updated_at = ? WHERE id = ?").run(now(), a.id);
            db.prepare("UPDATE password_reset_requests SET status = 'expired', decided_at = ? WHERE member_id = ? AND status = 'pending'").run(now(), a.id);
        })();
        audit(req, 'teacher', req.teacherId, 'account.remove', a.id);
        return json(reply, 200, { accountId: a.id, status: 'removed' });
    });
    for (const [path, status] of [['disable', 'disabled'], ['enable', 'active']]) {
        app.post(`/api/teacher/classes/:classKey/accounts/:accountId/${path}`, { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
            const a = teacherAccount(req, reply); if (!a) return;
            db.prepare('UPDATE student_accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), a.id);
            // 停用只影響本班；如果這是他唯一有效的班級，已登入的裝置立刻登出（和 v6.2 相同）
            if (status === 'disabled' && !otherLiveMemberships(a.user_id, a.id)) revokeAllOf('student', a.user_id);
            audit(req, 'teacher', req.teacherId, `account.${path}`, a.id);
            return json(reply, 200, accountView({ ...a, status }));
        });
    }

    // 小老師：只有老師能指定；取消後學生的工作階段不用重登，下一次請求就沒有權限
    app.post('/api/teacher/classes/:classKey/accounts/:accountId/helper', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['helper'], properties: { helper: { type: 'boolean' } } } },
    }, async (req, reply) => {
        const a = teacherAccount(req, reply); if (!a) return;
        const v = req.body.helper ? 1 : 0;
        db.prepare('UPDATE student_accounts SET is_helper = ?, updated_at = ? WHERE id = ?').run(v, now(), a.id);
        audit(req, 'teacher', req.teacherId, v ? 'account.helper.on' : 'account.helper.off', a.id);
        return json(reply, 200, accountView({ ...a, is_helper: v }));
    });

    // ------------------------------------------------------------ P2：邀請、加入申請、個別綁定碼（T25、T26、T31）
    const liveMember = (classId, userId) => db.prepare("SELECT * FROM student_accounts WHERE class_id = ? AND user_id = ? AND status IN ('active', 'disabled')").get(classId, userId);
    const localBound = (classId, localStudentId) => db.prepare("SELECT 1 FROM student_accounts WHERE class_id = ? AND local_student_id = ? AND status IN ('active', 'disabled')").get(classId, localStudentId);
    /**
     * 把 user 綁成某班某位本機學生（要在交易內呼叫）。本機學生只能由老師決定（核准時選，或老師印給該生的綁定碼）。
     * 以前退出或被移出這一班的人重新加入：沿用同一筆成員資料（UNIQUE(class_id, user_id)），重新選定本機學生、取消小老師。
     */
    const bindMember = (classId, userId, localStudentId, via) => {
        if (db.prepare('SELECT status FROM users WHERE id = ?').get(userId)?.status !== 'active') return { code: 409, error: 'user_inactive', message: '這個學生帳號已停用' };
        if (liveMember(classId, userId)) return { code: 409, error: 'already_member', message: '已經是這個班級的成員' };
        if (localBound(classId, localStudentId)) return { code: 409, error: 'already_bound', message: '這位學生已經綁定其他帳號；要換帳號請先把舊的移出本班' };
        if (db.prepare("SELECT COUNT(*) n FROM student_accounts WHERE class_id = ? AND status IN ('active', 'disabled')").get(classId).n >= LIMITS.accountsPerClass) return { code: 409, error: 'quota', message: `每個班級最多 ${LIMITS.accountsPerClass} 個學生帳號` };
        const t = now();
        const old = db.prepare('SELECT id FROM student_accounts WHERE class_id = ? AND user_id = ?').get(classId, userId);
        if (old) {
            db.prepare("UPDATE student_accounts SET status = 'active', local_student_id = ?, is_helper = 0, joined_via = ?, updated_at = ? WHERE id = ?").run(localStudentId, via, t, old.id);
            return { memberId: old.id };
        }
        const memberId = `s_${newToken().slice(0, 20)}`;
        db.prepare("INSERT INTO student_accounts (id, class_id, user_id, local_student_id, status, is_helper, joined_via, created_at, updated_at) VALUES (?,?,?,?,'active',0,?,?,?)").run(memberId, classId, userId, localStudentId, via, t, t);
        return { memberId };
    };
    const inviteLive = (i, t = now()) => !i.revoked_at && i.expires_at > t && i.used_count < i.max_uses;
    const inviteView = (i) => ({ id: i.id, createdAt: i.created_at, expiresAt: i.expires_at, maxUses: i.max_uses, usedCount: i.used_count, revoked: !!i.revoked_at, active: inviteLive(i) });
    /** 申請保留期限（T33）：待審超過 30 天自動過期；處理完超過 30 天的申請清掉學生填的名字 */
    const tidyJoinRequests = (classId) => {
        const cut = now() - LIMITS.joinKeepDays * DAY;
        db.prepare("UPDATE join_requests SET status = 'expired', decided_at = ?, display_name = '', seat_hint = NULL WHERE class_id = ? AND status = 'pending' AND created_at < ?").run(now(), classId, cut);
        db.prepare("UPDATE join_requests SET display_name = '', seat_hint = NULL WHERE class_id = ? AND status <> 'pending' AND decided_at < ? AND display_name <> ''").run(classId, cut);
    };

    app.post('/api/teacher/classes/:classKey/invitations', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, properties: { expiresInDays: { type: 'integer', minimum: 1, maximum: LIMITS.inviteMaxDays }, maxUses: { type: 'integer', minimum: 1, maximum: 200 } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const t = now();
        const live = db.prepare('SELECT * FROM class_invitations WHERE class_id = ?').all(c.id).filter(i => inviteLive(i, t)).length;
        if (live >= LIMITS.invitesPerClass) return fail(reply, 409, 'quota', `每個班級同時最多 ${LIMITS.invitesPerClass} 個有效的邀請碼，請先關閉舊的`);
        const code = generateCode();
        const inv = { id: `iv_${newToken().slice(0, 20)}`, created_at: t, expires_at: t + (req.body?.expiresInDays ?? LIMITS.inviteDefaultDays) * DAY, max_uses: req.body?.maxUses ?? LIMITS.inviteDefaultUses, used_count: 0, revoked_at: null };
        db.prepare('INSERT INTO class_invitations (id, class_id, code_hash, created_at, expires_at, max_uses) VALUES (?,?,?,?,?,?)').run(inv.id, c.id, codeHash(normalizeCode(code)), inv.created_at, inv.expires_at, inv.max_uses);
        audit(req, 'teacher', req.teacherId, 'invite.create', c.id, { id: inv.id });
        return json(reply, 200, { ...inviteView(inv), code });                     // 代碼原文只在這裡出現一次
    });
    app.get('/api/teacher/classes/:classKey/invitations', { preHandler: requireTeacher, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const rows = db.prepare('SELECT * FROM class_invitations WHERE class_id = ? AND created_at > ? ORDER BY created_at DESC').all(c.id, now() - 60 * DAY);
        return json(reply, 200, { invitations: rows.map(inviteView) });
    });
    app.post('/api/teacher/classes/:classKey/invitations/:invitationId/revoke', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const r = db.prepare('UPDATE class_invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND class_id = ?').run(now(), req.params.invitationId, c.id);
        if (!r.changes) return fail(reply, 404, 'not_found', '找不到這個邀請碼');
        audit(req, 'teacher', req.teacherId, 'invite.revoke', c.id, { id: req.params.invitationId });
        return json(reply, 200, inviteView(db.prepare('SELECT * FROM class_invitations WHERE id = ?').get(req.params.invitationId)));
    });

    // 加入申請：只有學生自己填的名字（不可信，只供參考）、座號提示與時間；沒有任何帳號或其他班級的資訊
    app.get('/api/teacher/classes/:classKey/join-requests', { preHandler: requireTeacher, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        tidyJoinRequests(c.id);
        const rows = db.prepare("SELECT id, display_name, seat_hint, created_at FROM join_requests WHERE class_id = ? AND status = 'pending' ORDER BY created_at, id").all(c.id);
        return json(reply, 200, { requests: rows.map(r => ({ id: r.id, displayName: r.display_name, seatHint: r.seat_hint, createdAt: r.created_at })) });
    });
    app.post('/api/teacher/classes/:classKey/join-requests/:requestId/approve', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['localStudentId'], properties: { localStudentId: { type: 'string', minLength: 1, maxLength: 64 } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        tidyJoinRequests(c.id);
        // 同一個交易裡重新讀申請、檢查、建立成員資格：同時按兩次核准，或兩筆申請搶同一位學生，只有一個會成功
        const out = db.transaction(() => {
            const r = db.prepare('SELECT * FROM join_requests WHERE id = ? AND class_id = ?').get(req.params.requestId, c.id);
            if (!r) return { code: 404, error: 'not_found', message: '找不到這筆申請' };
            if (r.status !== 'pending') return { code: 409, error: 'not_pending', message: '這筆申請已經處理過了' };
            const b = bindMember(c.id, r.user_id, req.body.localStudentId, 'invite');
            if (!b.memberId) return b;
            db.prepare("UPDATE join_requests SET status = 'approved', member_id = ?, decided_at = ? WHERE id = ?").run(b.memberId, now(), r.id);
            return { code: 200, memberId: b.memberId };
        }).immediate();
        if (out.code !== 200) return fail(reply, out.code, out.error, out.message);
        audit(req, 'teacher', req.teacherId, 'join.approve', out.memberId, { request: req.params.requestId });
        const m = db.prepare(`${MEMBER_SELECT} WHERE m.id = ?`).get(out.memberId);
        return json(reply, 200, accountView(m));
    });
    app.post('/api/teacher/classes/:classKey/join-requests/:requestId/reject', { preHandler: requireTeacher, schema: { body: NO_BODY } }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const r = db.prepare("UPDATE join_requests SET status = 'rejected', decided_at = ? WHERE id = ? AND class_id = ? AND status = 'pending'").run(now(), req.params.requestId, c.id);
        if (!r.changes) return fail(reply, 404, 'not_found', '找不到這筆待審的申請');
        audit(req, 'teacher', req.teacherId, 'join.reject', c.id, { request: req.params.requestId });
        return json(reply, 200, { ok: true });
    });

    // 個別綁定碼：老師替特定學生產生、印給他；一次性、30 天到期。同一位學生重新產生時，舊的未使用代碼自動作廢
    app.post('/api/teacher/classes/:classKey/claim-codes', {
        preHandler: requireTeacher,
        schema: { body: { type: 'object', additionalProperties: false, required: ['students'], properties: { students: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', additionalProperties: false, required: ['localStudentId'], properties: { localStudentId: { type: 'string', minLength: 1, maxLength: 64 } } } } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const codes = []; const existing = []; const t = now();
        db.transaction(() => {
            for (const localStudentId of new Set(req.body.students.map(s => s.localStudentId))) {
                if (localBound(c.id, localStudentId)) { existing.push(localStudentId); continue; }
                db.prepare('UPDATE claim_codes SET revoked_at = ? WHERE class_id = ? AND local_student_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(t, c.id, localStudentId);
                const code = generateCode(); const expiresAt = t + LIMITS.claimDays * DAY;
                db.prepare('INSERT INTO claim_codes (id, class_id, local_student_id, code_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(`cc_${newToken().slice(0, 20)}`, c.id, localStudentId, codeHash(normalizeCode(code)), t, expiresAt);
                codes.push({ localStudentId, code, expiresAt });
            }
        }).immediate();
        audit(req, 'teacher', req.teacherId, 'claim.create', c.id, { count: codes.length });
        return json(reply, 200, { codes, existing });
    });

    // 小老師登記收件匣：教師端依游標（seq）收取；回傳的學生 ID 都是教師端本機 ID
    app.get('/api/teacher/classes/:classKey/homework-registrations', {
        preHandler: requireTeacher,
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', pattern: '^[0-9]{1,15}$' } } } },
    }, async (req, reply) => {
        const c = ownClass(req, reply); if (!c) return;
        const after = Number(req.query.after || 0);
        db.prepare('DELETE FROM hw_registrations WHERE class_id = ? AND created_at < ?').run(c.id, now() - LIMITS.inboxKeepDays * 86400_000);
        const rows = db.prepare('SELECT * FROM hw_registrations WHERE class_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(c.id, after, LIMITS.inboxPage);
        const seats = new Map(db.prepare('SELECT local_student_id, data FROM student_projections WHERE class_id = ?').all(c.id).map(r => [r.local_student_id, JSON.parse(r.data).seat]));
        const last = db.prepare('SELECT MAX(seq) AS m FROM hw_registrations WHERE class_id = ?').get(c.id).m || 0;
        return json(reply, 200, {
            registrations: rows.map(r => ({ seq: r.seq, id: r.id, assignmentId: r.assignment_id, studentId: r.local_student_id, state: r.state, createdAt: r.created_at, helperStudentId: r.helper_local_id, helperSeat: seats.get(r.helper_local_id) ?? null })),
            next: rows.length ? rows[rows.length - 1].seq : after,
            more: rows.length ? rows[rows.length - 1].seq < last : false,
        });
    });

    app.put('/api/teacher/classes/:classKey/projection', {
        preHandler: requireTeacher, bodyLimit: LIMITS.projectionBody,
        schema: { body: { type: 'object', additionalProperties: false, required: ['version', 'hash', 'projection'], properties: { version: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, projection: { type: 'object' }, inboxSeq: { type: 'integer', minimum: 0 } } } },
    }, async (req, reply) => {
        if (!ownClass(req, reply)) return;
        const { version, hash, projection } = req.body;
        const inboxSeq = req.body.inboxSeq ?? 0;
        const errors = validateProjection(projection);
        if (errors.length) return json(reply, 400, { error: 'invalid_projection', message: '發布的資料格式不正確', details: errors.slice(0, 20) });
        if (await projectionHash(projection) !== hash) return fail(reply, 400, 'hash_mismatch', '資料雜湊不符');
        const t = now();
        // BUG-020：版本檢查與寫入在同一個交易裡、用交易內重新讀到的班級資料（重疊的發布不能讓舊版本蓋掉新版本）
        const outcome = db.transaction(() => {
            const c = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(req.params.classKey, req.teacherId);
            if (version < c.projection_version) return { code: 409, body: { error: 'stale', message: '已有較新的發布版本', currentVersion: c.projection_version } };
            if (version === c.projection_version) {
                if (hash === c.projection_hash) return { code: 200, body: { version, publishedAt: c.published_at, unchanged: true } };
                return { code: 409, body: { error: 'version_conflict', message: '同一版本的內容不同', currentVersion: c.projection_version } };
            }
            const keepS = projection.students.map(s => s.studentId); const keepG = projection.groups.map(g => g.groupId);
            db.prepare(`DELETE FROM student_projections WHERE class_id = ? AND local_student_id NOT IN (SELECT value FROM json_each(?))`).run(c.id, JSON.stringify(keepS));
            db.prepare(`DELETE FROM group_projections WHERE class_id = ? AND group_id NOT IN (SELECT value FROM json_each(?))`).run(c.id, JSON.stringify(keepG));
            const upS = db.prepare('INSERT OR REPLACE INTO student_projections (class_id, local_student_id, group_id, data, version) VALUES (?,?,?,?,?)');
            for (const s of projection.students) upS.run(c.id, s.studentId, s.groupId, JSON.stringify(s), version);
            const upG = db.prepare('INSERT OR REPLACE INTO group_projections (class_id, group_id, data, version) VALUES (?,?,?,?)');
            for (const g of projection.groups) upG.run(c.id, g.groupId, JSON.stringify(g), version);
            db.prepare('UPDATE classes SET projection_version = ?, projection_hash = ?, published_at = ?, name = ?, name_mode = ?, inbox_seq = MAX(inbox_seq, ?) WHERE id = ?')
                .run(version, hash, t, projection.className, projection.nameMode, inboxSeq, c.id);
            return { code: 200, body: { version, publishedAt: t, unchanged: false, students: projection.students.length, groups: projection.groups.length } };
        }).immediate();
        if (outcome.code === 200 && !outcome.body.unchanged) audit(req, 'teacher', req.teacherId, 'projection.publish', req.params.classKey, { version, students: projection.students.length });
        return json(reply, outcome.code, outcome.body);
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
        const cred = db.prepare('SELECT * FROM password_credentials WHERE username = ?').get(username);
        // BUG-021：先記一次「嘗試」再做非同步的 Argon2 驗證；否則同時送出的大量請求都會在計數增加前通過檢查
        ipFail(ipKey); userFail(userKey);
        const ok = cred ? await verifyPassword(cred.password_hash, req.body.password) : await dummyVerify(req.body.password);
        const u = cred ? db.prepare('SELECT * FROM users WHERE id = ?').get(cred.user_id) : null;
        if (!ok || !canUse(u)) {
            audit(req, 'anonymous', null, 'student.login.fail');
            return fail(reply, 401, 'invalid_credentials', '帳號或密碼錯誤');
        }
        rlReset(userKey); ipUndo(ipKey);
        revokeSession(req.cookies?.[COOKIE]);                                    // 防 session 固定：登入一定換新的
        const s = createSession('student', u.id, cred.must_change ? 'pwchange' : 'full');
        db.prepare("UPDATE student_accounts SET last_login_at = ? WHERE user_id = ? AND status = 'active'").run(now(), u.id);
        db.prepare('UPDATE password_credentials SET first_login_at = ? WHERE user_id = ? AND first_login_at IS NULL').run(now(), u.id);   // D3：從此老師不能重設
        db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?').run(now(), now() - 86400_000);
        audit(req, 'student', u.id, 'student.login');
        setStudentCookie(reply, s.token);
        return json(reply, 200, { mustChangePassword: !!cred.must_change, csrf: s.csrf });
    });

    app.post('/api/student/logout', { preHandler: studentGuard({ write: true, allowPwChange: true }), schema: { body: NO_BODY } }, async (req, reply) => {
        revokeSession(req.cookies[COOKIE]); clearStudentCookie(reply);
        return json(reply, 200, { ok: true });
    });

    app.post('/api/student/password', {
        preHandler: studentGuard({ write: true, allowPwChange: true }),
        schema: { body: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', maxLength: 128 }, newPassword: { type: 'string', maxLength: 128 } } } },
    }, async (req, reply) => {
        const { cred, user: u } = req.student;
        if (!cred) return fail(reply, 400, 'no_password', '這個帳號沒有設定密碼');
        const userKey = `user:${cred.username}`;
        if (userLockedFor(userKey) > 0) return fail(reply, 429, 'rate_limited', '嘗試太多次，請過幾分鐘再試');
        userFail(userKey);                                                       // 同上：先記再驗證
        if (!await verifyPassword(cred.password_hash, req.body.currentPassword)) return fail(reply, 400, 'wrong_password', '目前的密碼不正確');
        rlReset(userKey);
        const problem = passwordProblem(req.body.newPassword, { username: cred.username });
        if (problem) return fail(reply, 400, 'weak_password', problem);
        if (await verifyPassword(cred.password_hash, req.body.newPassword)) return fail(reply, 400, 'weak_password', '新密碼不能和目前的一樣');
        db.prepare('UPDATE password_credentials SET password_hash = ?, must_change = 0, updated_at = ? WHERE user_id = ?').run(await hashPassword(req.body.newPassword), now(), u.id);
        revokeAllOf('student', u.id);                                           // 其他裝置上的舊 Session 全部失效
        const s = createSession('student', u.id, 'full');
        audit(req, 'student', u.id, 'student.password');
        setStudentCookie(reply, s.token);
        return json(reply, 200, { ok: true, csrf: s.csrf });
    });

    app.get('/api/student/me', { preHandler: studentGuard({ allowPwChange: true }), schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const { user: u, cred, session: s } = req.student;
        const ms = s.scope === 'full' ? activeMembers(u.id) : [];
        // classes：只有自己有效的班級（自己在該班的代號、班級名稱、是不是小老師）；沒有 classKey、名冊或其他成員的資料
        // helper：舊版學生頁用（只有一個班級時才有意義）
        return json(reply, 200, { username: cred?.username ?? null, mustChangePassword: s.scope !== 'full', csrf: s.csrf,
            helper: ms.length === 1 && !!ms[0].is_helper, classes: ms.map(m => ({ id: m.id, className: m.class_name, helper: !!m.is_helper })) });
    });

    // ------------------------------------------------------------ P2：學生用邀請碼申請加入、用綁定碼直接綁定、自己退出
    const CODE_BODY = { code: { type: 'string', minLength: 1, maxLength: 32 } };
    const badCode = (req, reply, userId, what) => {
        codeFail(req, userId);
        audit(req, 'student', userId, `${what}.fail`);
        return fail(reply, 404, 'invalid_code', '這個代碼不能用：可能打錯、過期，或已經被老師關閉');
    };
    const rateLimitedCode = (reply) => { reply.header('Retry-After', String(LIMITS.ipWindowMs / 1000)); return fail(reply, 429, 'rate_limited', '輸入錯誤太多次，請過 15 分鐘再試'); };
    /** 邀請碼只會產生「申請」：不給任何班級資料、名冊或成員資格；要等老師選定是哪一位學生才算加入（T25） */
    app.post('/api/student/join', {
        preHandler: studentGuard({ write: true }),
        schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'displayName'], properties: { ...CODE_BODY, displayName: { type: 'string', maxLength: 60 }, seatHint: { type: 'integer', minimum: 1, maximum: 99 } } } },
    }, async (req, reply) => {
        const u = req.student.user;
        if (codeLimited(req, u.id)) return rateLimitedCode(reply);
        const displayName = cleanName(req.body.displayName);
        if (!displayName) return fail(reply, 400, 'bad_name', '請輸入你的名字（1～20 個字）');
        const code = normalizeCode(req.body.code);
        const inv = code && db.prepare(`SELECT i.*, c.name AS class_name FROM class_invitations i JOIN classes c ON c.id = i.class_id JOIN teachers t ON t.id = c.teacher_id
            WHERE i.code_hash = ? AND c.status = 'active' AND t.status = 'active'`).get(codeHash(code));
        if (!inv || !inviteLive(inv)) return badCode(req, reply, u.id, 'join');
        const out = db.transaction(() => {
            if (liveMember(inv.class_id, u.id)) return { code: 409, error: 'already_member', message: '你已經在這個班級了' };
            if (db.prepare("SELECT 1 FROM join_requests WHERE class_id = ? AND user_id = ? AND status = 'pending'").get(inv.class_id, u.id)) return { code: 200, replay: true };
            const fresh = db.prepare('SELECT * FROM class_invitations WHERE id = ?').get(inv.id);
            if (!inviteLive(fresh)) return { code: 404, error: 'invalid_code', message: '這個代碼不能用：可能打錯、過期，或已經被老師關閉' };
            if (db.prepare("SELECT COUNT(*) n FROM join_requests WHERE class_id = ? AND status = 'pending'").get(inv.class_id).n >= LIMITS.pendingPerClass) return { code: 409, error: 'too_many_requests', message: '這個班級待確認的申請太多了，請找老師' };
            db.prepare("INSERT INTO join_requests (id, class_id, user_id, invitation_id, display_name, seat_hint, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)")
                .run(`jr_${newToken().slice(0, 20)}`, inv.class_id, u.id, inv.id, displayName, req.body.seatHint ?? null, now());
            db.prepare('UPDATE class_invitations SET used_count = used_count + 1 WHERE id = ?').run(inv.id);
            return { code: 200, replay: false };
        }).immediate();
        if (out.code !== 200) return fail(reply, out.code, out.error, out.message);
        if (!out.replay) audit(req, 'student', u.id, 'join.request', inv.class_id);
        return json(reply, 200, { status: 'pending', className: inv.class_name, message: '已送出，等老師確認' });
    });
    /** 個別綁定碼：老師印給某位學生的一次性代碼 → 直接成為那一班的那一位學生 */
    app.post('/api/student/claim', {
        preHandler: studentGuard({ write: true }),
        schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: CODE_BODY } },
    }, async (req, reply) => {
        const u = req.student.user;
        if (codeLimited(req, u.id)) return rateLimitedCode(reply);
        const code = normalizeCode(req.body.code);
        const cc = code && db.prepare(`SELECT k.*, c.name AS class_name FROM claim_codes k JOIN classes c ON c.id = k.class_id JOIN teachers t ON t.id = c.teacher_id
            WHERE k.code_hash = ? AND c.status = 'active' AND t.status = 'active'`).get(codeHash(code));
        if (!cc || cc.used_at || cc.revoked_at || cc.expires_at <= now()) return badCode(req, reply, u.id, 'claim');
        const out = db.transaction(() => {
            const fresh = db.prepare('SELECT used_at, revoked_at FROM claim_codes WHERE id = ?').get(cc.id);
            if (fresh.used_at || fresh.revoked_at) return { code: 404, error: 'invalid_code', message: '這個代碼不能用：可能打錯、過期，或已經被老師關閉' };
            const b = bindMember(cc.class_id, u.id, cc.local_student_id, 'claim');
            if (!b.memberId) return b;
            db.prepare('UPDATE claim_codes SET used_at = ?, used_by_user_id = ? WHERE id = ?').run(now(), u.id, cc.id);
            db.prepare("UPDATE join_requests SET status = 'cancelled', decided_at = ? WHERE class_id = ? AND user_id = ? AND status = 'pending'").run(now(), cc.class_id, u.id);
            return { code: 200, memberId: b.memberId };
        }).immediate();
        if (out.code !== 200) return fail(reply, out.code, out.error, out.message);
        audit(req, 'student', u.id, 'claim.use', out.memberId);
        return json(reply, 200, { id: out.memberId, className: cc.class_name });
    });
    /** 自己退出某一班：立即失效；照顧紀錄留在那一班（老師端的統計不變） */
    app.route({ method: 'POST', url: '/api/student/classes/:memberId/leave', preHandler: [studentGuard({ write: true }), withMember], schema: { params: MEMBER_PARAMS, body: NO_BODY },
        handler: async (req, reply) => {
            const a = req.student.account;
            db.prepare("UPDATE student_accounts SET status = 'left', is_helper = 0, updated_at = ? WHERE id = ?").run(now(), a.id);
            audit(req, 'student', req.student.user.id, 'member.leave', a.id);
            return json(reply, 200, { ok: true });
        } });

    const classInfo = (a) => db.prepare('SELECT name, published_at, projection_version FROM classes WHERE id = ?').get(a.class_id);

    studentRoute('GET', 'dashboard', { schema: { querystring: NO_QUERY } }, async (req, reply) => {
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

    studentRoute('GET', 'homework', { schema: { querystring: NO_QUERY } }, async (req, reply) => {
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
    studentRoute('GET', 'zoo', { schema: { querystring: NO_QUERY } }, async (req, reply) => json(reply, 200, zooView(req.student.account)));

    studentRoute('POST', 'care', {
        write: true,
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
            if (slot === null) {
                // BUG-025：次數用完只回「不計入」；不計入的紀錄每天最多留 30 筆（給冪等用），不會無限新增資料列
                const extra = db.prepare('SELECT COUNT(*) AS n FROM group_care_events WHERE account_id = ? AND local_date = ? AND slot IS NULL').get(a.id, today).n;
                if (extra >= LIMITS.uncountedCarePerDay) return { code: 200, counted: false, replay: false, groupId: me.groupId };
            }
            db.prepare('INSERT INTO group_care_events (id, class_id, group_id, account_id, item_id, action, local_date, slot, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(`ce_${newToken().slice(0, 20)}`, a.class_id, me.groupId, a.id, itemId, action, today, slot, idempotencyKey, now());
            return { code: 200, counted: slot !== null, replay: false, groupId: me.groupId };
        }).immediate();
        if (result.code !== 200) return fail(reply, result.code, result.error, result.message);
        const view = zooView(a);
        return json(reply, 200, { counted: result.counted, replay: result.replay, myToday: view.myToday, animal: view.care?.animals?.[itemId] || null, care: view.care });
    });

    // ============================================================ 小老師（登記全班作業）
    // 權限一律從工作階段推導：帳號必須是這個班級老師指定的小老師；只能登記自己班級、已發布名單上的同學，不能登記自己。
    // 看得到：同學座號（只顯示座號模式下沒有姓名）與作業狀態。看不到：分數、愛心、其他班級。
    const helperGuard = (req, reply) => {
        const a = req.student.account;
        // 不在目前名單上的學生（轉出、被老師從發布中移除）即使帳號還開著，也不能當小老師
        if (!a.is_helper || !myProjection(a)) { fail(reply, 403, 'not_helper', '你不是小老師'); return false; }
        return true;
    };
    const helperView = (a) => {
        const c = db.prepare('SELECT name, published_at, inbox_seq FROM classes WHERE id = ?').get(a.class_id);
        const rows = db.prepare('SELECT data FROM student_projections WHERE class_id = ?').all(a.class_id).map(r => JSON.parse(r.data))
            .sort((x, y) => (x.seat ?? 999) - (y.seat ?? 999) || String(x.studentId).localeCompare(String(y.studentId)));
        const assignments = new Map();
        for (const s of rows) for (const hw of s.homework) if (!assignments.has(hw.assignmentId)) assignments.set(hw.assignmentId, { assignmentId: hw.assignmentId, title: hw.title, type: hw.type, assignedDate: hw.assignedDate, dueDate: hw.dueDate });
        const states = {};
        for (const s of rows) for (const hw of s.homework) (states[hw.assignmentId] ||= {})[s.studentId] = simpleOf(hw.submission, hw.correction);
        // 教師端還沒收取／還沒重新發布的登記：蓋在投影上面，小老師馬上看得到自己剛剛的登記
        const pending = db.prepare('SELECT assignment_id, local_student_id, state FROM hw_registrations WHERE class_id = ? AND seq > ? ORDER BY seq').all(a.class_id, c.inbox_seq || 0);
        for (const r of pending) if (states[r.assignment_id] && r.local_student_id in states[r.assignment_id]) states[r.assignment_id][r.local_student_id] = r.state;
        return {
            published: rows.length > 0, publishedAt: c.published_at, className: c.name, selfId: a.local_student_id,
            students: rows.map(s => ({ studentId: s.studentId, seat: s.seat, name: s.name })),
            assignments: [...assignments.values()].sort((x, y) => (y.assignedDate || '').localeCompare(x.assignedDate || '')),
            states,
        };
    };
    studentRoute('GET', 'helper', { schema: { querystring: NO_QUERY } }, async (req, reply) => {
        if (!helperGuard(req, reply)) return;
        return json(reply, 200, helperView(req.student.account));
    });
    studentRoute('POST', 'helper/register', {
        write: true,
        schema: { body: { type: 'object', additionalProperties: false, required: ['assignmentId', 'studentIds', 'state', 'idempotencyKey'], properties: {
            assignmentId: { type: 'string', minLength: 1, maxLength: 64 },
            studentIds: { type: 'array', minItems: 1, maxItems: 80, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
            state: { type: 'string', maxLength: 16 }, idempotencyKey: KEY } } },
    }, async (req, reply) => {
        if (!helperGuard(req, reply)) return;
        const { account: a } = req.student;
        const { assignmentId, studentIds, state, idempotencyKey } = req.body;
        if (!isSimpleState(state)) return fail(reply, 400, 'bad_request', '不明的狀態');
        if (studentIds.includes(a.local_student_id)) return fail(reply, 403, 'self', '自己的作業請交給老師登記');
        const today = localDate(now());
        const result = db.transaction(() => {
            const prev = db.prepare('SELECT assignment_id, state, local_student_id FROM hw_registrations WHERE helper_account_id = ? AND idempotency_key = ?').all(a.id, idempotencyKey);
            if (prev.length) {
                const same = prev.every(p => p.assignment_id === assignmentId && p.state === state) && prev.length === studentIds.length && studentIds.every(id => prev.some(p => p.local_student_id === id));
                return same ? { code: 200, saved: prev.length, replay: true } : { code: 409, error: 'idempotency_conflict', message: '同一個操作代碼用在不同的登記' };
            }
            const roster = new Map(db.prepare('SELECT local_student_id, data FROM student_projections WHERE class_id = ?').all(a.class_id).map(r => [r.local_student_id, JSON.parse(r.data)]));
            if (!studentIds.every(id => roster.has(id))) return { code: 400, error: 'bad_student', message: '名單上沒有這位同學' };
            if (![...roster.values()].some(s => s.homework.some(hw => hw.assignmentId === assignmentId))) return { code: 404, error: 'not_found', message: '找不到這份作業' };
            const exempt = studentIds.filter(id => roster.get(id).homework.some(hw => hw.assignmentId === assignmentId && hw.submission === 'exempt'));
            if (exempt.length) return { code: 409, error: 'exempt', message: '老師設為免交的同學不能登記' };
            const used = db.prepare('SELECT COUNT(*) AS n FROM hw_registrations WHERE helper_account_id = ? AND local_date = ?').get(a.id, today).n;
            if (used + studentIds.length > LIMITS.helperRowsPerDay) return { code: 429, error: 'rate_limited', message: '今天登記的次數太多了，請找老師' };
            const ins = db.prepare('INSERT INTO hw_registrations (id, class_id, helper_account_id, helper_local_id, assignment_id, local_student_id, state, local_date, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
            const t = now();
            for (const sid of studentIds) ins.run(`hr_${newToken().slice(0, 20)}`, a.class_id, a.id, a.local_student_id, assignmentId, sid, state, today, idempotencyKey, t);
            return { code: 200, saved: studentIds.length, replay: false };
        }).immediate();
        if (result.code !== 200) return fail(reply, result.code, result.error, result.message);
        if (!result.replay) audit(req, 'student', a.id, 'helper.register', a.class_id, { count: result.saved, state });   // a.id＝成員 id（每班不同）
        const view = helperView(a);
        return json(reply, 200, { saved: result.saved, replay: result.replay, states: view.states[assignmentId] || {} });
    });

    // ============================================================ 平台管理員（D3a、T34）
    // 只有 platform_admins 裡的身分能用（本版只有一位 owner）。第一次：Google 帳號的 email 已驗證、在設定的管理員 email 裡，
    // 而且還沒有任何 owner → 建立；之後只認身分雜湊，不再看 email。管理 API 只用 Bearer（不用 Cookie），工作階段 4 小時。
    const adminEnabled = adminEmails.length > 0;
    const requireAdmin = async (req, reply) => {
        if (!adminEnabled) return fail(reply, 404, 'not_found', '找不到');
        const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
        const s = m && liveSession(m[1], 'admin');
        if (!s) return fail(reply, 401, 'unauthenticated', '請重新登入');
        if (!db.prepare('SELECT 1 FROM platform_admins WHERE user_id = ?').get(s.subject_id)) { revokeSession(m[1]); return fail(reply, 403, 'not_admin', '沒有管理權限'); }
        req.adminId = s.subject_id; req.adminToken = m[1];
    };
    app.post('/api/admin/session', {
        schema: { body: { type: 'object', additionalProperties: false, required: ['credential', 'nonce'], properties: { credential: { type: 'string', maxLength: 4096 }, nonce: { type: 'string', minLength: 8, maxLength: 128 } } } },
    }, async (req, reply) => {
        if (!adminEnabled) return fail(reply, 404, 'not_found', '找不到');
        const ipKey = `aip:${ipHash(req)}`;
        if (ipFailures(ipKey) >= LIMITS.teacherIpFailLimit) return fail(reply, 429, 'rate_limited', '嘗試太多次，請稍後再試');
        const { credential, nonce } = req.body;
        let id;
        try { id = await verifyIdToken(credential, nonce); }
        catch (e) {
            ipFail(ipKey);
            audit(req, 'anonymous', null, 'admin.session.fail', null, { code: e instanceof IdTokenError ? e.code : 'error' });
            return fail(reply, 401, 'invalid_token', '無法驗證 Google 登入，請重新登入');
        }
        if (!consumeIdToken(credential, id)) { ipFail(ipKey); return fail(reply, 401, 'replayed', '這個登入憑證已經用過，請重新登入'); }
        const subjectHash = sha256(`https://accounts.google.com|${id.sub}`);
        const userId = db.transaction(() => {
            const ident = db.prepare("SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject_hash = ?").get(subjectHash);
            if (ident && db.prepare('SELECT 1 FROM platform_admins WHERE user_id = ?').get(ident.user_id)) return ident.user_id;
            const bootstrap = id.emailVerified && adminEmails.includes(String(id.email || '').toLowerCase()) && !db.prepare("SELECT 1 FROM platform_admins WHERE role = 'owner'").get();
            if (!bootstrap) return null;
            const uid = userForIdentity(subjectHash, now());
            db.prepare("INSERT INTO platform_admins (user_id, role, created_at) VALUES (?, 'owner', ?)").run(uid, now());
            return uid;
        }).immediate();
        if (!userId) {
            ipFail(ipKey);
            audit(req, 'anonymous', null, 'admin.session.denied');
            return fail(reply, 403, 'not_admin', '這個 Google 帳號沒有管理權限');
        }
        const s = createSession('admin', userId);
        audit(req, 'admin', userId, 'admin.session');
        return json(reply, 200, { token: s.token, expiresAt: s.expiresAt });
    });
    app.post('/api/admin/logout', { preHandler: requireAdmin, schema: { body: NO_BODY } }, async (req, reply) => { revokeSession(req.adminToken); return json(reply, 200, { ok: true }); });

    /** 重設申請：管理員看得到班級名稱、帳號名稱、這個人在幾位老師的班上；看不到成績或其他資料 */
    const resetView = (r) => {
        const m = db.prepare('SELECT m.*, c.name AS class_name, c.teacher_id FROM student_accounts m JOIN classes c ON c.id = m.class_id WHERE m.id = ?').get(r.member_id);
        const cred = m && db.prepare('SELECT username, issued_by_class_id FROM password_credentials WHERE user_id = ?').get(m.user_id);
        const teachers = m ? db.prepare("SELECT COUNT(DISTINCT c.teacher_id) n FROM student_accounts x JOIN classes c ON c.id = x.class_id WHERE x.user_id = ? AND x.status IN ('active', 'disabled')").get(m.user_id).n : 0;
        return { id: r.id, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, requestedBy: r.requested_by, className: m?.class_name ?? null, memberStatus: m?.status ?? null,
            username: cred?.username ?? null, issuedByThisClass: !!cred && cred.issued_by_class_id === m?.class_id, teacherCount: teachers };
    };
    app.get('/api/admin/reset-requests', { preHandler: requireAdmin, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        db.prepare("UPDATE password_reset_requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?").run(now(), now() - LIMITS.resetRequestDays * DAY);
        const pending = db.prepare("SELECT * FROM password_reset_requests WHERE status = 'pending' ORDER BY created_at").all();
        const recent = db.prepare("SELECT * FROM password_reset_requests WHERE status <> 'pending' ORDER BY decided_at DESC LIMIT 50").all();
        return json(reply, 200, { pending: pending.map(resetView), recent: recent.map(resetView) });
    });
    const ADMIN_ID_PARAMS = (name) => ({ type: 'object', additionalProperties: false, required: [name], properties: { [name]: { type: 'string', pattern: '^[A-Za-z0-9_-]{4,64}$' } } });
    app.post('/api/admin/reset-requests/:requestId/approve', { preHandler: requireAdmin, schema: { params: ADMIN_ID_PARAMS('requestId'), body: NO_BODY } }, async (req, reply) => {
        const initialPassword = generateInitialPassword(); const hash = await hashPassword(initialPassword);
        const out = db.transaction(() => {
            const r = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(req.params.requestId);
            if (!r) return { code: 404, error: 'not_found', message: '找不到這筆申請' };
            if (r.status !== 'pending') return { code: 409, error: 'not_pending', message: '這筆申請已經處理過了' };
            const m = db.prepare("SELECT m.*, c.teacher_id FROM student_accounts m JOIN classes c ON c.id = m.class_id WHERE m.id = ? AND m.status IN ('active', 'disabled')").get(r.member_id);
            // 送出申請之後學生被移出、或老師已不是這班的老師 → 申請作廢
            if (!m || m.teacher_id !== r.requested_by) { db.prepare("UPDATE password_reset_requests SET status = 'expired', decided_at = ? WHERE id = ?").run(now(), r.id); return { code: 409, error: 'stale', message: '學生已不在這個班級，申請作廢' }; }
            const cred = db.prepare('SELECT username FROM password_credentials WHERE user_id = ?').get(m.user_id);
            if (!cred) return { code: 409, error: 'no_password', message: '這位學生沒有帳號密碼' };
            db.prepare('UPDATE password_credentials SET password_hash = ?, must_change = 1, updated_at = ? WHERE user_id = ?').run(hash, now(), m.user_id);
            db.prepare("UPDATE password_reset_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?").run(now(), req.adminId, r.id);
            return { code: 200, userId: m.user_id, username: cred.username, memberId: m.id };
        }).immediate();
        if (out.code !== 200) return fail(reply, out.code, out.error, out.message);
        revokeAllOf('student', out.userId); rlReset(`user:${out.username}`);
        audit(req, 'admin', req.adminId, 'reset.approve', out.memberId, { request: req.params.requestId });
        return json(reply, 200, { username: out.username, initialPassword });            // 只顯示這一次；學生登入後必須改密碼
    });
    app.post('/api/admin/reset-requests/:requestId/reject', { preHandler: requireAdmin, schema: { params: ADMIN_ID_PARAMS('requestId'), body: NO_BODY } }, async (req, reply) => {
        const r = db.prepare("UPDATE password_reset_requests SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(now(), req.adminId, req.params.requestId);
        if (!r.changes) return fail(reply, 404, 'not_found', '找不到這筆待審的申請');
        audit(req, 'admin', req.adminId, 'reset.reject', null, { request: req.params.requestId });
        return json(reply, 200, { ok: true });
    });
    /** 老師名單（不存 email，所以用老師 id、註冊方式和班級名稱辨識） */
    app.get('/api/admin/teachers', { preHandler: requireAdmin, schema: { querystring: NO_QUERY } }, async (req, reply) => {
        const rows = db.prepare('SELECT * FROM teachers ORDER BY created_at').all();
        const classes = db.prepare('SELECT name, created_at FROM classes WHERE teacher_id = ? ORDER BY created_at');
        return json(reply, 200, { teachers: rows.map(t => ({ id: t.id, status: t.status, signup: t.signup, createdAt: t.created_at, classes: classes.all(t.id).map(c => c.name) })) });
    });
    for (const [path, status] of [['suspend', 'suspended'], ['unsuspend', 'active']]) {
        app.post(`/api/admin/teachers/:teacherId/${path}`, { preHandler: requireAdmin, schema: { params: ADMIN_ID_PARAMS('teacherId'), body: NO_BODY } }, async (req, reply) => {
            const r = db.prepare('UPDATE teachers SET status = ? WHERE id = ?').run(status, req.params.teacherId);
            if (!r.changes) return fail(reply, 404, 'not_found', '找不到這位老師');
            if (status === 'suspended') revokeAllOf('teacher', req.params.teacherId);
            audit(req, 'admin', req.adminId, `teacher.${path}`, req.params.teacherId);
            return json(reply, 200, { id: req.params.teacherId, status });
        });
    }
    app.get('/api/admin/audit', {
        preHandler: requireAdmin,
        schema: { querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^[0-9]{1,15}$' } } } },
    }, async (req, reply) => {
        const before = req.query.before ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
        const rows = db.prepare('SELECT id, ts, actor_kind, actor_id, action, target, detail FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, LIMITS.auditPage);
        return json(reply, 200, { events: rows.map(r => ({ id: r.id, ts: r.ts, actorKind: r.actor_kind, actorId: r.actor_id, action: r.action, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null })) });
    });

    // ============================================================ 學生頁面（同源靜態檔，只開放白名單）
    if (config.staticRoot) {
        const root = resolve(config.staticRoot);
        const allowed = (p) => p === '/student.html' || p === '/src/ui/dom.js' || /^\/src\/(core|data|art|student)\/[A-Za-z0-9_\-/]+\.(js|css)$/.test(p) || /^\/assets\/[A-Za-z0-9_\-/]+\.(webp|png|svg)$/.test(p);
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
