// 後端測試工具（不隨 App 出貨）：記憶體資料庫、測試金鑰簽的 Google ID token、可控制的時鐘。
// 驗證流程與正式環境相同（verifyGoogleIdToken）；只是公開金鑰換成本次測試產生的那一把。
import { buildApp } from '../../server/src/app.mjs';
import { openDb } from '../../server/src/db.mjs';
import { createTestKeys, signJwt, basePayload, TEST_CLIENT_ID, TEACHER_A, TEACHER_B } from './fake-google.mjs';
import { buildClassProjection, projectionHash } from '../../src/core/student-projection.js';
import { buildFixture, classData } from './v62-fixture.mjs';

export const TEACHER_ORIGIN = 'http://localhost:8765';
export const STUDENT_ORIGIN = 'http://localhost:8790';
export { TEACHER_A, TEACHER_B };

let keysP = null;
export const testKeys = () => (keysP ??= createTestKeys());

export const makeHarness = async ({ start = Date.parse('2026-11-25T09:00:00+08:00') } = {}) => {
    const keys = await testKeys();
    const clock = { t: start };
    const db = openDb(':memory:');
    const app = buildApp({
        db, now: () => clock.t, jwks: async () => keys.jwks,
        config: { clientId: TEST_CLIENT_ID, teacherOrigins: [TEACHER_ORIGIN], studentOrigins: [STUDENT_ORIGIN], ipSalt: 'test-salt-0123456789', cookieSecure: true },
    });
    await app.ready();
    let n = 0;
    const H = {
        app, db, clock, keys,
        advance: (ms) => { clock.t += ms; },
        /** 簽一張 Google ID token（預設：教師甲、正確 aud、現在簽發） */
        idToken: async ({ account = TEACHER_A, nonce = `nonce-${++n}-abcdef`, mutate = (p) => p, key = keys.good.privateKey, header } = {}) => {
            const p = mutate(basePayload({ account, nonce, nowS: Math.floor(clock.t / 1000) }));
            return { credential: await signJwt(key, p, header), nonce };
        },
        teacherSession: async (account = TEACHER_A) => {
            const { credential, nonce } = await H.idToken({ account });
            const r = await app.inject({ method: 'POST', url: '/api/teacher/session', headers: { origin: TEACHER_ORIGIN }, payload: { credential, nonce } });
            if (r.statusCode !== 200) throw new Error(`teacher session ${r.statusCode} ${r.body}`);
            return r.json().token;
        },
        t: (token, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, origin: TEACHER_ORIGIN }, ...(payload !== undefined ? { payload } : {}) }),
        /** 學生請求：帶 cookie；寫入時加 CSRF 與 Origin */
        s: (sess, method, url, payload, extraHeaders = {}) => app.inject({
            method, url,
            headers: { ...(sess?.cookie ? { cookie: sess.cookie } : {}), ...(method !== 'GET' ? { origin: STUDENT_ORIGIN, 'x-fhes-csrf': sess?.csrf || '' } : {}), ...extraHeaders },
            ...(payload !== undefined ? { payload } : {}),
        }),
        login: async (username, password, extra = {}) => {
            const r = await app.inject({ method: 'POST', url: '/api/student/login', headers: { origin: STUDENT_ORIGIN, ...extra }, payload: { username, password } });
            const c = r.cookies.find(x => x.name === '__Host-fhes_sid');
            return { res: r, cookie: c ? `${c.name}=${c.value}` : null, token: c?.value, csrf: r.statusCode === 200 ? r.json().csrf : null };
        },
        /** 登入並完成首次改密碼 → 回傳可正常使用的 session */
        activate: async (acc, newPassword = `Garden-${acc.accountId.slice(-6)}-ok`) => {
            const first = await H.login(acc.username, acc.initialPassword);
            if (first.res.statusCode !== 200) throw new Error(`login ${first.res.statusCode}`);
            const r = await H.s(first, 'POST', '/api/student/password', { currentPassword: acc.initialPassword, newPassword });
            if (r.statusCode !== 200) throw new Error(`password ${r.statusCode} ${r.body}`);
            const c = r.cookies.find(x => x.name === '__Host-fhes_sid');
            return { cookie: `${c.name}=${c.value}`, token: c.value, csrf: r.json().csrf, password: newPassword, username: acc.username };
        },
    };
    return H;
};

/** 教師甲建立甲班、發放全部帳號、發布投影 → { token, classKey, accounts: Map(localStudentId → {username, initialPassword, accountId}), projection } */
export const seedClass = async (H, { account = TEACHER_A, classId = 'cls-a', fixture = buildFixture(), version = 1, today = '2026-11-25' } = {}) => {
    const token = await H.teacherSession(account);
    const cls = fixture.classes.find(c => c.id === classId);
    const { classKey } = (await H.t(token, 'POST', '/api/teacher/classes', { localClassId: cls.id, name: cls.name })).json();
    const projection = buildClassProjection(classData(fixture, classId), { today });
    const r = await H.t(token, 'POST', `/api/teacher/classes/${classKey}/accounts`, { students: projection.students.map(s => ({ localStudentId: s.studentId })) });
    const accounts = new Map(r.json().created.map(a => [a.localStudentId, a]));
    const pub = await H.t(token, 'PUT', `/api/teacher/classes/${classKey}/projection`, { version, hash: await projectionHash(projection), projection });
    if (pub.statusCode !== 200) throw new Error(`publish ${pub.statusCode} ${pub.body}`);
    return { token, classKey, accounts, projection, fixture };
};

export const publish = async (H, token, classKey, projection, version) =>
    H.t(token, 'PUT', `/api/teacher/classes/${classKey}/projection`, { version, hash: await projectionHash(projection), projection });
