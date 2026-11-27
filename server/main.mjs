// v6.2 學生系統 API 正式入口。只在本機或測試容器執行；正式 VPS 部署需另外批准（docs/STUDENT-DEPLOY-TODO.md）。
// 設定全部來自環境變數；缺少必要設定就拒絕啟動。Google 公開金鑰一律從 Google 取得，沒有任何略過驗證的開關。
import { buildApp } from './src/app.mjs';
import { openDb } from './src/db.mjs';
import { GOOGLE_CLIENT_ID } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google JWKS 快取：依 Cache-Control max-age；找不到 kid 時強制重抓（至少間隔 60 秒） */
export const googleJwks = (fetchFn = fetch) => {
    let cache = null; let until = 0; let lastForced = 0;
    return async (force = false) => {
        const t = Date.now();
        if (cache && !force && t < until) return cache;
        if (cache && force && t - lastForced < 60_000) return cache;
        if (force) lastForced = t;
        const r = await fetchFn(GOOGLE_JWKS_URL);
        if (!r.ok) throw new Error('無法取得 Google 公開金鑰');
        cache = await r.json();
        const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
        until = t + Math.min(Number(m?.[1] || 3600), 86400) * 1000;
        return cache;
    };
};

const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

export const configFromEnv = (env = process.env) => {
    const cfg = {
        clientId: env.FHES_GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID,
        teacherOrigins: list(env.FHES_TEACHER_ORIGINS),
        teacherSignup: env.FHES_TEACHER_SIGNUP || 'allowlist',             // allowlist（預設）或 open（任何 email 已驗證的 Google 帳號都能註冊老師，D5）
        teacherAllow: list(env.FHES_TEACHER_ALLOW),                         // 允許的老師：完整 email 或 @學校網域
        adminEmails: list(env.FHES_ADMIN_EMAIL),                            // 平台管理員（第一次登入後只認身分雜湊）；沒設定＝管理 API 關閉
        adminOrigins: env.FHES_ADMIN_ORIGINS ? list(env.FHES_ADMIN_ORIGINS) : undefined,   // 預設＝教師來源
        codePepper: env.FHES_CODE_PEPPER || undefined,
        studentGoogle: env.FHES_STUDENT_GOOGLE === 'on',                  // P3：學生 Google 登入（預設 off；學校要先把 App 設成信任，見部署指南）                      // 選用：邀請碼／綁定碼 HMAC 的金鑰（預設由 FHES_IP_SALT 分開推導）
        studentOrigins: list(env.FHES_STUDENT_ORIGINS),
        ipSalt: env.FHES_IP_SALT || '',
        cookieSecure: env.FHES_COOKIE_SECURE !== '0',
        trustProxy: env.FHES_TRUST_PROXY === '1' ? 1 : false,           // 只信任一層反向代理（nginx）
        staticRoot: env.FHES_STATIC_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        dbPath: env.FHES_DB_PATH || '',
        host: env.FHES_HOST || '127.0.0.1',
        port: Number(env.FHES_PORT || 8790),
        logger: env.FHES_LOG === '1',
    };
    const missing = [];
    if (!cfg.dbPath) missing.push('FHES_DB_PATH');
    if (cfg.ipSalt.length < 16) missing.push('FHES_IP_SALT（至少 16 個字元的亂數）');
    if (!cfg.teacherOrigins.length) missing.push('FHES_TEACHER_ORIGINS');
    if (!cfg.studentOrigins.length) missing.push('FHES_STUDENT_ORIGINS');
    if (!['', 'on', 'off'].includes(env.FHES_STUDENT_GOOGLE || '')) throw new Error('FHES_STUDENT_GOOGLE 只能是 on 或 off');
    if (!['allowlist', 'open'].includes(cfg.teacherSignup)) throw new Error('FHES_TEACHER_SIGNUP 只能是 allowlist 或 open');
    if (cfg.teacherSignup === 'allowlist' && !cfg.teacherAllow.length) missing.push('FHES_TEACHER_ALLOW（允許的老師 email 或 @網域；或設定 FHES_TEACHER_SIGNUP=open）');
    const local = cfg.studentOrigins.every(o => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
    if (!local && !['0', '1'].includes(env.FHES_TRUST_PROXY)) missing.push('FHES_TRUST_PROXY（在 nginx 後面請設 1，直接對外請設 0）');
    if (missing.length) throw new Error(`缺少設定：${missing.join('、')}`);
    if (!cfg.cookieSecure && !cfg.studentOrigins.every(o => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)))
        throw new Error('FHES_COOKIE_SECURE=0 只能用在本機 http://localhost');
    return cfg;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cfg = configFromEnv();
    const app = buildApp({ db: openDb(cfg.dbPath), config: cfg, jwks: googleJwks() });
    await app.listen({ host: cfg.host, port: cfg.port });
    console.log(`FHES student API listening on http://${cfg.host}:${cfg.port}`);
}
