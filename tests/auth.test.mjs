// 登入身分驗證（ID token）、試算表授權帳號綁定、舊資料轉移規則、登入相關守門規則。
// 金鑰每次測試重新產生；帳號為 example.test 合成帳號。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyGoogleIdToken, accountKey, makeNonce, IdTokenError, SKEW_SECONDS } from '../src/auth/id-token.js';
import { legacySummary, planLegacyImport, planUndoImport, hasLegacyContent } from '../src/core/legacy.js';
import { checkFile } from '../scripts/guardrails.mjs';
import { createTestKeys, signJwt, basePayload, TEST_CLIENT_ID, OTHER_CLIENT_ID, TEACHER_A, TEACHER_B, KID } from './helpers/fake-google.mjs';

let K;
before(async () => { K = await createTestKeys(); });
const NOW = Date.UTC(2026, 10, 25, 1, 0, 0);
const nowS = Math.floor(NOW / 1000);
const NONCE = 'n-0123456789abcdef';
const opts = (o = {}) => ({ clientId: TEST_CLIENT_ID, jwks: K.jwks, nonce: NONCE, now: NOW, ...o });
const good = (patch = {}, header) => signJwt(K.good.privateKey, { ...basePayload({ nowS, nonce: NONCE }), ...patch }, header);
const rejects = async (tokenP, code, o) => {
    await assert.rejects(verifyGoogleIdToken(await tokenP, opts(o)), (e) => e instanceof IdTokenError && e.code === code, `expected ${code}`);
};

// ---------- ID token：正例 ----------
test('valid Google ID token → identity keyed by sub (email is informational only)', async () => {
    const id = await verifyGoogleIdToken(await good(), opts());
    assert.equal(id.sub, TEACHER_A.sub);
    assert.equal(id.email, TEACHER_A.email);
    assert.equal(id.emailVerified, true);
    assert.ok(Object.isFrozen(id));
    // 兩種 issuer 寫法都接受
    assert.equal((await verifyGoogleIdToken(await good({ iss: 'accounts.google.com' }), opts())).sub, TEACHER_A.sub);
});
test('clock skew: token expired 30 s ago is still accepted, 2 min ago is rejected', async () => {
    await verifyGoogleIdToken(await good({ exp: nowS - 30 }), opts());
    await rejects(good({ exp: nowS - SKEW_SECONDS - 60 }), 'expired');
});

// ---------- ID token：負例（每一條規則都要能攔下） ----------
test('negative: forged signature (attacker key with the same kid) is rejected', async () => {
    await rejects(signJwt(K.rogue.privateKey, basePayload({ nowS, nonce: NONCE })), 'signature');
});
test('negative: payload tampered after signing (sub swapped) is rejected', async () => {
    const [h, , sig] = (await good()).split('.');
    const forged = Buffer.from(JSON.stringify({ ...basePayload({ account: TEACHER_B, nowS, nonce: NONCE }) })).toString('base64url');
    await rejects(Promise.resolve(`${h}.${forged}.${sig}`), 'signature');
});
test('negative: decoding alone is not trusted — alg none / HS256 / missing signature are rejected', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const p = enc(basePayload({ nowS, nonce: NONCE }));
    await rejects(Promise.resolve(`${enc({ alg: 'none', kid: KID })}.${p}.`), 'alg');
    await rejects(Promise.resolve(`${enc({ alg: 'HS256', kid: KID })}.${p}.abc`), 'alg');
    await rejects(Promise.resolve(`${enc({ alg: 'RS256', kid: KID })}.${p}.`), 'signature');
});
test('negative: unknown kid, wrong issuer, wrong audience, wrong azp', async () => {
    await rejects(good({}, { alg: 'RS256', kid: 'not-a-google-key', typ: 'JWT' }), 'kid');
    await rejects(good({ iss: 'https://evil.example.test' }), 'iss');
    await rejects(good({ aud: OTHER_CLIENT_ID, azp: OTHER_CLIENT_ID }), 'aud');
    await rejects(good({ azp: OTHER_CLIENT_ID }), 'aud');
    // 同一個 token 拿到另一個 App（不同 Client ID）也不會被接受
    await rejects(good(), 'aud', { clientId: OTHER_CLIENT_ID });
});
test('negative: expired, issued in the future, not yet valid', async () => {
    await rejects(good({ iat: nowS - 7200, exp: nowS - 3600 }), 'expired');
    await rejects(good({ iat: nowS + 600, exp: nowS + 4200 }), 'iat');
    await rejects(good({ nbf: nowS + 600 }), 'iat');
    await rejects(good({ exp: undefined }), 'expired');
});
test('negative: nonce mismatch or missing nonce (replay) is rejected', async () => {
    await rejects(good({ nonce: 'other' }), 'nonce');
    await rejects(signJwt(K.good.privateKey, basePayload({ nowS })), 'nonce');
});
test('negative: missing sub, malformed tokens, missing configuration', async () => {
    await rejects(good({ sub: '' }), 'sub');
    await rejects(good({ sub: 12345 }), 'sub');
    await rejects(Promise.resolve('only.two'), 'malformed');
    await rejects(Promise.resolve('a.b.c.d'), 'malformed');
    await rejects(Promise.resolve('@@@.###.$$$'), 'malformed');
    await rejects(Promise.resolve(null), 'malformed');
    await rejects(good(), 'config', { clientId: '' });
    await rejects(good(), 'kid', { jwks: { keys: [] } });
});

// ---------- 帳號資料區代號 ----------
test('accountKey: deterministic per sub, different subs differ, never contains the sub or email', async () => {
    const a1 = await accountKey(TEACHER_A.sub); const a2 = await accountKey(TEACHER_A.sub); const b = await accountKey(TEACHER_B.sub);
    assert.equal(a1, a2); assert.notEqual(a1, b);
    assert.match(a1, /^[0-9a-f]{32}$/);
    assert.ok(!a1.includes(TEACHER_A.sub));
    await assert.rejects(accountKey(''), IdTokenError);
});
test('nonce: high entropy and unique', () => {
    const set = new Set(Array.from({ length: 200 }, () => makeNonce(webcrypto)));
    assert.equal(set.size, 200);
    for (const n of set) assert.match(n, /^[A-Za-z0-9_-]{24}$/);
});

// ---------- 試算表授權帳號＝登入帳號 ----------
const fakeWindow = ({ grantedSub, scope = 'openid https://www.googleapis.com/auth/drive.file', deny = false }) => {
    const log = { revoked: [], hint: null };
    globalThis.window = { google: { accounts: {
        id: {},
        oauth2: {
            initTokenClient: (o) => ({ requestAccessToken: (r) => { log.hint = r?.login_hint || o.hint; queueMicrotask(() => deny ? o.callback({ error: 'access_denied' }) : o.callback({ access_token: `at.${grantedSub}.1`, expires_in: 3600, scope })); } }),
            hasGrantedAllScopes: (resp, ...s) => s.every(x => resp.scope.split(' ').includes(x)),
            revoke: (t, cb) => { log.revoked.push(t); cb(); },
        },
    } } };
    return log;
};
const userinfoFetch = (calls) => async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const sub = /^Bearer at\.([^.]+)\.\d+$/.exec(init?.headers?.Authorization || '')?.[1];
    return { ok: !!sub, status: sub ? 200 : 401, json: async () => ({ sub }) };
};
test('Sheets authorization succeeds only when the granted account is the signed-in account (sub match, token never in the URL)', async () => {
    const { createGoogleAuth } = await import('../src/sync/google-auth.js');
    const log = fakeWindow({ grantedSub: TEACHER_A.sub });
    const calls = [];
    const auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: TEACHER_A.sub, loginHint: TEACHER_A.email, fetchFn: userinfoFetch(calls) });
    await auth.connect();
    assert.equal(await auth.getToken(), `at.${TEACHER_A.sub}.1`);
    assert.equal(log.hint, TEACHER_A.email, 'consent window pre-selects the signed-in account');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes('at.'), 'token is not put in the URL');
    assert.match(calls[0].auth, /^Bearer /);
    delete globalThis.window;
});
test('negative: a different Google account in the consent window is refused and its token revoked', async () => {
    const { createGoogleAuth } = await import('../src/sync/google-auth.js');
    const log = fakeWindow({ grantedSub: TEACHER_B.sub });
    const auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: TEACHER_A.sub, fetchFn: userinfoFetch([]) });
    await assert.rejects(auth.connect(), (e) => e.kind === 'account-mismatch');
    assert.deepEqual(log.revoked, [`at.${TEACHER_B.sub}.1`]);
    assert.equal(auth.isConnected(), false);
    await assert.rejects(auth.getToken(), (e) => e.kind === 'auth');
    delete globalThis.window;
});
test('negative: missing drive.file scope, denied consent, no signed-in account', async () => {
    const { createGoogleAuth } = await import('../src/sync/google-auth.js');
    const log = fakeWindow({ grantedSub: TEACHER_A.sub, scope: 'openid' });
    let auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: TEACHER_A.sub, fetchFn: userinfoFetch([]) });
    await assert.rejects(auth.connect(), (e) => e.kind === 'permission');
    assert.equal(log.revoked.length, 1, 'token without file scope is revoked');
    fakeWindow({ grantedSub: TEACHER_A.sub, deny: true });
    auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: TEACHER_A.sub, fetchFn: userinfoFetch([]) });
    await assert.rejects(auth.connect(), (e) => e.kind === 'permission');
    auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: '', fetchFn: userinfoFetch([]) });
    await assert.rejects(auth.connect(), (e) => e.kind === 'auth');
    // userinfo 失敗（例如 401）→ 不接受 token
    fakeWindow({ grantedSub: TEACHER_A.sub });
    auth = createGoogleAuth({ clientId: TEST_CLIENT_ID, expectedSub: TEACHER_A.sub, fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await assert.rejects(auth.connect(), (e) => e.kind === 'auth');
    assert.equal(auth.isConnected(), false);
    delete globalThis.window;
});

// ---------- 舊資料轉移（不自動指定、只複製勾選的班級、不覆蓋） ----------
const legacy = {
    classes: [{ id: 'c1', name: '舊甲班' }, { id: 'c2', name: '舊乙班' }, { id: 'c3', name: '已刪班', deleted: true }],
    students: [{ id: 's1', classId: 'c1', name: '甲一' }, { id: 's2', classId: 'c1', name: '甲二', removed: true }, { id: 's3', classId: 'c2', name: '乙一' }],
    events: [{ id: 'e1', classId: 'c1' }, { id: 'e2', classId: 'c2' }, { id: 'e3', classId: 'c2' }],
    dailySnapshots: [{ id: 'd1', classId: 'c2' }],
    hwEvents: [{ id: 'h1', classId: 'c1' }],
};
test('legacy summary lists alive classes with counts; deleted classes are hidden', () => {
    assert.deepEqual(legacySummary(legacy).map(r => [r.id, r.students, r.events]), [['c1', 1, 1], ['c2', 1, 2]]);
    assert.equal(hasLegacyContent(legacy), true);
    assert.equal(hasLegacyContent({ classes: [{ id: 'x', deleted: true }] }), false);
    assert.equal(hasLegacyContent({}), false);
});
test('legacy import copies only the selected classes and their records; existing classes are skipped, not overwritten', () => {
    const plan = planLegacyImport(legacy, ['c2', 'c1'], ['c1']);
    assert.deepEqual(plan.imported, ['c2']);
    assert.deepEqual(plan.skipped, ['c1']);
    assert.deepEqual(plan.puts.classes.map(c => c.id), ['c2']);
    assert.deepEqual(plan.puts.events.map(e => e.id), ['e2', 'e3']);
    assert.deepEqual(plan.puts.dailySnapshots.map(e => e.id), ['d1']);
    assert.deepEqual(plan.puts.hwEvents, []);
    plan.puts.classes[0].name = 'changed';
    assert.equal(legacy.classes[1].name, '舊乙班', 'plan is a deep copy; legacy data untouched');
    assert.deepEqual(planLegacyImport(legacy, [], []).imported, [], 'nothing selected → nothing imported');
    assert.deepEqual(planLegacyImport(legacy, ['c3', 'zz'], []).imported, [], 'deleted or unknown classes are never imported');
});
test('undo plan removes everything that belongs to the imported classes only', () => {
    const state = { classes: [{ id: 'c2' }, { id: 'mine' }], students: [{ id: 's3', classId: 'c2' }, { id: 'm1', classId: 'mine' }], events: [{ id: 'e2', classId: 'c2' }, { id: 'new', classId: 'c2' }] };
    const dels = planUndoImport(state, ['c2']);
    assert.deepEqual(dels.classes, ['c2']); assert.deepEqual(dels.students, ['s3']); assert.deepEqual(dels.events, ['e2', 'new']);
});

// ---------- 守門規則：登入憑證 ----------
test('negative: persisting a credential or logging it is rejected by the guardrails', () => {
    assert.ok(checkFile('src/ui/auth-ui.js', "localStorage.setItem('fhes_token', resp.credential);").length > 0);
    assert.ok(checkFile('index.html', "sessionStorage.setItem('idToken', t);").length > 0);
    assert.ok(checkFile('src/ui/sync-ui.js', "await app.setMeta('auth', { accessToken });").length > 0);
    assert.ok(checkFile('src/auth/google-signin.js', 'console.log(resp.credential);').length > 0);
    assert.ok(checkFile('src/ui/x.js', "const p = JSON.parse(atob(token.split('.')[1]));").length > 0, 'decode-only JWT handling');
    assert.ok(checkFile('src/auth/google-signin.js', "import { h } from '../ui/dom.js';").length > 0, 'auth must not import ui');
    assert.ok(checkFile('src/auth/id-token.js', 'window.foo = 1;').length > 0, 'verifier stays pure');
});
test('positive: storing the public client id and non-secret notices is allowed', () => {
    assert.deepEqual(checkFile('src/ui/auth-ui.js', "localStorage.setItem('fhes_google_client_id', v); sessionStorage.setItem('fhes_auth_notice', 'switch');"), []);
});

test('authorized origins: exact origin string match like Google (localhost ≠ 127.0.0.1, port matters); empty list = no check', async () => {
    const { originAllowed } = await import('../src/auth/google-signin.js');
    const { GOOGLE_AUTHORIZED_ORIGINS } = await import('../src/config.js');
    const list = ['http://localhost:8765', 'https://yongliancai.github.io'];
    assert.equal(originAllowed('http://localhost:8765', list), true);
    assert.equal(originAllowed('https://yongliancai.github.io', list), true);
    assert.equal(originAllowed('http://127.0.0.1:8765', list), false, '127.0.0.1 is a different origin');
    assert.equal(originAllowed('http://localhost:8766', list), false, 'port must match');
    assert.equal(originAllowed('https://localhost:8765', list), false, 'scheme must match');
    assert.equal(originAllowed('https://yongliancai.github.io.evil.test', list), false);
    assert.equal(originAllowed('http://anything', []), true);
    // 設定檔與 Google Cloud 上的設定一致（使用者 2026-11-25 提供）
    assert.deepEqual([...GOOGLE_AUTHORIZED_ORIGINS].sort(), [...list].sort());
});
