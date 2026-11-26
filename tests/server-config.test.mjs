// v6.2 後端正式入口：缺設定就拒絕啟動；Google 公開金鑰快取與強制重抓的頻率限制
import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, googleJwks, GOOGLE_JWKS_URL } from '../server/main.mjs';

const ok = { FHES_TEACHER_ALLOW: '@school.example.test', FHES_TRUST_PROXY: '1', FHES_DB_PATH: 'x.db', FHES_IP_SALT: 'a'.repeat(32), FHES_TEACHER_ORIGINS: 'https://yongliancai.github.io', FHES_STUDENT_ORIGINS: 'https://fhes.example.test' };

test('production config: refuses to start without DB path, salt or origins; insecure cookies only on localhost', () => {
    for (const k of Object.keys(ok)) assert.throws(() => configFromEnv({ ...ok, [k]: '' }), /缺少設定/, k);
    assert.equal(configFromEnv({ ...ok, FHES_TRUST_PROXY: '', FHES_STUDENT_ORIGINS: 'http://localhost:8790' }).trustProxy, false, 'trust-proxy may be omitted only for localhost');
    assert.throws(() => configFromEnv({ ...ok, FHES_IP_SALT: 'short' }), /FHES_IP_SALT/);
    assert.throws(() => configFromEnv({ ...ok, FHES_COOKIE_SECURE: '0' }), /localhost/);
    assert.equal(configFromEnv({ ...ok, FHES_COOKIE_SECURE: '0', FHES_STUDENT_ORIGINS: 'http://localhost:8790' }).cookieSecure, false);
    const c = configFromEnv(ok);
    assert.deepEqual([c.cookieSecure, c.host, c.port, c.trustProxy], [true, '127.0.0.1', 8790, 1]);
    assert.match(c.clientId, /apps\.googleusercontent\.com$/);
});

test('JWKS: always fetched from Google, cached by max-age, forced refresh at most once a minute', async () => {
    const urls = [];
    const fetchFn = async (u) => { urls.push(u); return { ok: true, headers: new Headers({ 'cache-control': 'public, max-age=3600' }), json: async () => ({ keys: [{ kid: String(urls.length) }] }) }; };
    const j = googleJwks(fetchFn);
    await j(); await j();
    assert.equal(urls.length, 1); assert.equal(urls[0], GOOGLE_JWKS_URL);
    await j(true); await j(true); await j(true);
    assert.equal(urls.length, 2, 'unknown kid can force at most one refresh per minute (no fetch amplification)');
});

test('deploy/fhes-student.env.example: refuses to start until the salt placeholder is replaced, then the config is complete', async () => {
    const { readFileSync } = await import('node:fs');
    const env = Object.fromEntries(readFileSync(new URL('../deploy/fhes-student.env.example', import.meta.url), 'utf8').split(/\r?\n/)
        .filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.throws(() => configFromEnv(env), /FHES_IP_SALT/, 'placeholder salt is rejected');
    const c = configFromEnv({ ...env, FHES_IP_SALT: 'f'.repeat(64) });
    assert.deepEqual([c.trustProxy, c.host, c.port, c.teacherAllow.length > 0], [1, '127.0.0.1', 8790, true]);
});
