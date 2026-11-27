// 測試用「假 Google」（不隨 App 出貨）：
// - 假的 Google Identity Services 程式庫（google.accounts.id + google.accounts.oauth2），在瀏覽器裡用測試金鑰「真的」簽 RS256 ID token
// - 對應的 JWKS（公開金鑰）與 userinfo 端點
// 每次執行測試都重新產生金鑰（不寫入檔案、不進 Git）。合成帳號一律用 example.test 網域。
import { webcrypto } from 'node:crypto';

export const TEST_CLIENT_ID = '1234567890-testclientabc.apps.googleusercontent.com';
export const OTHER_CLIENT_ID = '9999999999-otherclientxyz.apps.googleusercontent.com';
export const TEACHER_A = Object.freeze({ sub: '100000000000000000001', email: 'teacher.a@example.test', name: '測試老師甲' });
export const TEACHER_B = Object.freeze({ sub: '100000000000000000002', email: 'teacher.b@example.test', name: '測試老師乙' });
/** 平台管理員（D3a）：只在後端測試用；E2E 不建立管理員 */
export const ADMIN = Object.freeze({ sub: '100000000000000000099', email: 'owner@admin.example.test', name: '測試管理員' });
export const KID = 'fhes-test-kid-1';

const gen = () => webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

/** 產生一組測試金鑰：good（JWKS 公開的那把）與 rogue（攻擊者自己的金鑰，用來做偽造簽章的負例） */
export const createTestKeys = async () => {
    const good = await gen(); const rogue = await gen();
    const pub = await webcrypto.subtle.exportKey('jwk', good.publicKey);
    return {
        good, rogue,
        jwks: { keys: [{ kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid: KID }] },
        goodPrivateJwk: await webcrypto.subtle.exportKey('jwk', good.privateKey),
        roguePrivateJwk: await webcrypto.subtle.exportKey('jwk', rogue.privateKey),
    };
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
/** Node 端簽 JWT（單元測試用） */
export const signJwt = async (privateKey, payload, header = { alg: 'RS256', kid: KID, typ: 'JWT' }) => {
    const h = b64url(JSON.stringify(header)); const p = b64url(JSON.stringify(payload));
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
};
export const basePayload = ({ account = TEACHER_A, clientId = TEST_CLIENT_ID, nowS = Math.floor(Date.now() / 1000), nonce } = {}) => ({
    iss: 'https://accounts.google.com', azp: clientId, aud: clientId, sub: account.sub, email: account.email, email_verified: true,
    name: account.name, iat: nowS, exp: nowS + 3600, ...(nonce ? { nonce } : {}),
});

/**
 * 瀏覽器端假 GIS 程式碼。測試用 window.__fakeGoogle 控制：
 *   account：下一次按登入按鈕選的帳號；mode：'ok'|'cancel'|'badsig'|'expired'|'wrongaud'|'wrongiss'|'nonce'|'algnone'|'nosub'
 *   oauthAccount：試算表授權視窗選的帳號（預設＝最後登入的帳號）；denyScope；noDriveScope；tokenGen
 */
export const fakeGisScript = ({ goodPrivateJwk, roguePrivateJwk, clientId = TEST_CLIENT_ID, defaultAccount = TEACHER_A }) => `(() => {
  const F = window.__fakeGoogle = Object.assign({ account: ${JSON.stringify(defaultAccount)}, mode: 'ok', tokenGen: 1, log: [] }, window.__fakeGoogle || {});
  const enc = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  const keyOf = (jwk) => crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const GOOD = ${JSON.stringify(goodPrivateJwk)}; const ROGUE = ${JSON.stringify(roguePrivateJwk)};
  let cfg = null; let last = null;
  const makeToken = async (acc, mode) => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: mode === 'algnone' ? 'none' : 'RS256', kid: '${KID}', typ: 'JWT' };
    const p = { iss: mode === 'wrongiss' ? 'https://evil.example.test' : 'https://accounts.google.com', azp: mode === 'wrongaud' ? '${OTHER_CLIENT_ID}' : cfg.client_id,
      aud: mode === 'wrongaud' ? '${OTHER_CLIENT_ID}' : cfg.client_id, sub: mode === 'nosub' ? '' : acc.sub, email: acc.email, email_verified: true, name: acc.name,
      iat: mode === 'expired' ? now - 7300 : now, exp: mode === 'expired' ? now - 3700 : now + 3600, nonce: mode === 'nonce' ? 'replayed-nonce' : cfg.nonce };
    const data = enc(header) + '.' + enc(p);
    if (mode === 'algnone') return data + '.';
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await keyOf(mode === 'badsig' ? ROGUE : GOOD), new TextEncoder().encode(data));
    return data + '.' + b64(sig);
  };
  window.google = { accounts: {
    id: {
      initialize: (c) => { cfg = c; F.log.push('initialize'); },
      renderButton: (el) => {
        const b = document.createElement('button'); b.type = 'button'; b.id = 'fake-gsi-btn'; b.textContent = '使用 Google 帳號登入（測試）';
        b.addEventListener('click', async () => {
          F.log.push('click:' + F.mode);
          if (F.mode === 'cancel') return;                       // 使用者關閉視窗：GIS 不會回呼
          const acc = F.account; const credential = await makeToken(acc, F.mode);
          F.lastCredential = credential; last = acc;
          cfg.callback({ credential, select_by: 'btn' });
        });
        el.replaceChildren(b);
      },
      disableAutoSelect: () => { F.disabledAutoSelect = true; F.log.push('disableAutoSelect'); },
      prompt: () => {}, cancel: () => {},
    },
    oauth2: {
      initTokenClient: (o) => ({ requestAccessToken: (opts) => setTimeout(() => {
        F.log.push('requestAccessToken');
        F.lastHint = (opts && opts.login_hint) || o.hint;
        if (F.denyScope) { o.callback({ error: 'access_denied' }); return; }
        const acc = F.oauthAccount || last || F.account;
        const access_token = 'at.' + acc.sub + '.' + F.tokenGen;
        F.lastAccessToken = access_token;
        o.callback({ access_token, expires_in: F.expiresIn || 3600, scope: F.noDriveScope ? 'openid' : o.scope, token_type: 'Bearer' });
      }, 20) }),
      hasGrantedAllScopes: (resp, ...scopes) => scopes.every(s => String(resp.scope || '').split(' ').includes(s)),
      // 與真的 GIS 一樣向 Google 撤銷端點發出請求（POST 內容，不放網址）；測試在網路層記錄
      revoke: (t, cb) => { F.log.push('revoke'); (F.revoked = F.revoked || []).push(t);
        fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: 'token=' + encodeURIComponent(t), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, keepalive: true })
          .catch(() => {}).finally(() => cb && cb()); },
    },
  } };
})();`;

/** 由假 access token 解析帳號 sub（userinfo 與 Sheets 模擬器使用） */
export const subOfAccessToken = (t) => { const m = /^at\.([^.]+)\.\d+$/.exec(String(t || '')); return m ? m[1] : null; };
