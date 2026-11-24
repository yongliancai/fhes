// Google ID Token（OpenID Connect JWT）驗證 — 純函式，不碰 DOM／儲存空間，Node 與瀏覽器共用。
//
// 依 Google「Verify the Google ID token」的要求逐項檢查（ADR-011）：
//   1. 三段式 JWT、header.alg 必須是 RS256（拒絕 none／HS256 等）
//   2. 用 Google 公開金鑰（JWKS，依 kid 選）驗證 RSASSA-PKCS1-v1_5 / SHA-256 簽章
//   3. iss ∈ { accounts.google.com, https://accounts.google.com }
//   4. aud（若有 azp 也檢查）必須等於本 App 的 OAuth Client ID
//   5. exp 未過期、iat 不在未來（各容許 SKEW 秒時鐘誤差）
//   6. nonce 必須等於這次登入產生的一次性亂數（防重放）
//   7. sub 必須存在 —— 帳號主鍵一律用 sub，不用 email
// 注意：只「解碼」payload 不算驗證；本模組在簽章與上述欄位全部通過前不回傳任何身分。
// 注意：這是瀏覽器端驗證，是「防偽造／防誤用」的關卡，不是伺服器端存取控制（見 docs/DECISIONS.md ADR-011）。

export const GOOGLE_ISSUERS = Object.freeze(['accounts.google.com', 'https://accounts.google.com']);
export const SKEW_SECONDS = 60;

export class IdTokenError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const b64urlToBytes = (s) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new IdTokenError('malformed', 'ID token 格式錯誤');
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};
const b64urlJson = (s) => {
    try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }
    catch (e) { throw e instanceof IdTokenError ? e : new IdTokenError('malformed', 'ID token 內容無法解析'); }
};

/**
 * 驗證 Google ID token。全部通過才回傳身分；任何一項不符就丟 IdTokenError。
 * @param {string} token
 * @param {{ clientId: string, jwks: {keys: object[]}, nonce?: string, now?: number, subtle?: SubtleCrypto }} opts
 *        now：毫秒；nonce：這次登入要求時產生的一次性值（有提供就必須相符）
 */
export const verifyGoogleIdToken = async (token, { clientId, jwks, nonce, now = Date.now(), subtle = globalThis.crypto?.subtle } = {}) => {
    if (!clientId) throw new IdTokenError('config', '缺少 OAuth Client ID');
    if (!subtle) throw new IdTokenError('config', '此瀏覽器不支援 Web Crypto，無法驗證登入');
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) throw new IdTokenError('malformed', 'ID token 格式錯誤');
    const [h64, p64, s64] = parts;
    const header = b64urlJson(h64);
    if (header?.alg !== 'RS256') throw new IdTokenError('alg', `不接受的簽章演算法：${String(header?.alg)}`);
    const jwk = (jwks?.keys || []).find(k => k && k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) throw new IdTokenError('kid', '找不到對應的 Google 公開金鑰（kid）');

    let valid;
    try {
        const key = await subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
    } catch { valid = false; }
    if (!valid) throw new IdTokenError('signature', 'ID token 簽章驗證失敗');

    const p = b64urlJson(p64);
    const nowS = Math.floor(now / 1000);
    if (!GOOGLE_ISSUERS.includes(p.iss)) throw new IdTokenError('iss', 'ID token 發行者不是 Google');
    const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!auds.includes(clientId)) throw new IdTokenError('aud', 'ID token 不是發給本 App 的（audience 不符）');
    if (p.azp !== undefined && p.azp !== clientId) throw new IdTokenError('aud', 'ID token 的授權方（azp）不符');
    if (typeof p.exp !== 'number' || p.exp + SKEW_SECONDS < nowS) throw new IdTokenError('expired', 'ID token 已過期');
    if (typeof p.iat !== 'number' || p.iat - SKEW_SECONDS > nowS) throw new IdTokenError('iat', 'ID token 簽發時間不合理');
    if (typeof p.nbf === 'number' && p.nbf - SKEW_SECONDS > nowS) throw new IdTokenError('iat', 'ID token 尚未生效');
    if (nonce !== undefined && p.nonce !== nonce) throw new IdTokenError('nonce', 'ID token 的 nonce 不符（可能是重放）');
    if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 255) throw new IdTokenError('sub', 'ID token 缺少帳號識別碼（sub）');

    return Object.freeze({
        sub: p.sub,
        email: typeof p.email === 'string' ? p.email : '',
        emailVerified: p.email_verified === true || p.email_verified === 'true',
        name: typeof p.name === 'string' ? p.name : '',
        hd: typeof p.hd === 'string' ? p.hd : '',
        exp: p.exp * 1000,
        iat: p.iat * 1000,
    });
};

/** 帳號資料區代號：SHA-256(iss|sub) 前 32 個十六進位字元（不把 sub／email 直接放進資料庫名稱） */
export const accountKey = async (sub, subtle = globalThis.crypto?.subtle) => {
    if (typeof sub !== 'string' || !sub) throw new IdTokenError('sub', '缺少帳號識別碼');
    const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`https://accounts.google.com|${sub}`)));
    return [...d].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
};

/** 一次性 nonce（至少 128 bits） */
export const makeNonce = (rng = globalThis.crypto) => {
    const a = new Uint8Array(18); rng.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
