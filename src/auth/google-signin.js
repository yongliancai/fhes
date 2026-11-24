// Google 登入（Authentication）：Google Identity Services「Sign in with Google」按鈕 → ID token → 本機驗證簽章與欄位。
// 與「Google 試算表授權（Authorization）」分開：那是 src/sync/google-auth.js 的 access token（只放記憶體）。
//
// 生命週期（ADR-011）：
//   signed-out ──按鈕──▶ verifying ──驗證通過──▶ signed-in（記憶體中的 identity，最長 SESSION_MAX_MS）
//        ▲                    └─失敗/取消─▶ signed-out（顯示原因，不解鎖）
//        └──────── 登出／切換帳號／工作階段到期／重新整理（整頁重新載入，記憶體全部清空）
// 不寫入任何儲存空間：ID token 驗證完就丟掉，只留下 sub／email／name 在記憶體。
import { verifyGoogleIdToken, IdTokenError, makeNonce } from './id-token.js';

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** 一次登入最長可用時間（一個上課日）；到期就鎖回登入畫面 */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const isValidClientId = (id) => /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(id || '').trim());

/** 目前網址的來源是否在已授權清單內（清單為空 = 不檢查）。只比對完整來源字串，與 Google 的規則相同。 */
export const originAllowed = (origin, list) => !Array.isArray(list) || list.length === 0 || list.includes(String(origin));

let gisPromise = null;
/** 載入 Google Identity Services 程式庫（登入與試算表授權共用同一支） */
export const loadGis = () => gisPromise || (gisPromise = new Promise((ok, no) => {
    if (window.google?.accounts?.id && window.google?.accounts?.oauth2) { ok(window.google.accounts); return; }
    const sc = document.createElement('script');
    sc.src = GIS_SRC; sc.async = true; sc.defer = true;
    sc.onload = () => window.google?.accounts?.id ? ok(window.google.accounts) : (gisPromise = null, no(new Error('gis-missing')));
    sc.onerror = () => { gisPromise = null; sc.remove(); no(new Error('gis-network')); };
    document.head.appendChild(sc);
}));

/**
 * @param {{ clientId: string, fetchFn?: typeof fetch, now?: () => number }} opts
 */
export const createGoogleSignIn = ({ clientId, fetchFn = (...a) => fetch(...a), now = () => Date.now() }) => {
    let jwks = null;
    let nonce = null;
    const getJwks = async (force = false) => {
        if (jwks && !force) return jwks;
        const r = await fetchFn(GOOGLE_JWKS_URL, { cache: 'no-store', credentials: 'omit' });
        if (!r.ok) throw new IdTokenError('jwks', '無法取得 Google 公開金鑰');
        jwks = await r.json();
        return jwks;
    };
    /** 驗證 GIS 回傳的 credential；kid 不在快取中時重新抓一次金鑰（Google 會輪替金鑰） */
    const verify = async (credential, expectedNonce) => {
        try { return await verifyGoogleIdToken(credential, { clientId, jwks: await getJwks(), nonce: expectedNonce, now: now() }); }
        catch (e) {
            if (e instanceof IdTokenError && e.code === 'kid') return verifyGoogleIdToken(credential, { clientId, jwks: await getJwks(true), nonce: expectedNonce, now: now() });
            throw e;
        }
    };

    return {
        clientId,
        /**
         * 在 container 放「使用 Google 帳號登入」按鈕。
         * onResult({ identity }) 或 onResult({ error })；取消登入時 GIS 不會回呼 → 保持未登入。
         */
        async mount(container, { onVerifying, onResult }) {
            const accounts = await loadGis();
            const init = () => {
                const myNonce = nonce = makeNonce();
                accounts.id.initialize({
                    client_id: clientId, nonce: myNonce, auto_select: false, cancel_on_tap_outside: true,
                    ux_mode: 'popup', itp_support: true, use_fedcm_for_button: true,
                    callback: async (resp) => {
                        if (myNonce !== nonce) return;            // 舊的初始化（已被取代）不處理
                        init();                                    // 一次性：下一次登入換新的 nonce
                        onVerifying?.();
                        try {
                            if (!resp || typeof resp.credential !== 'string') throw new IdTokenError('malformed', '沒有收到 Google 登入憑證');
                            const identity = await verify(resp.credential, myNonce);
                            onResult({ identity: Object.freeze({ ...identity, signedInAt: now(), sessionExpiresAt: now() + SESSION_MAX_MS }) });
                        } catch (e) {
                            onResult({ error: e instanceof IdTokenError ? e : new IdTokenError('network', '登入驗證時網路中斷，請再試一次') });
                        }
                    },
                });
            };
            init();
            accounts.id.renderButton(container, { type: 'standard', theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left', locale: 'zh-TW', width: 280 });
        },
        /** 登出：不再自動選擇此帳號（共用電腦） */
        async signOut() {
            try { (await loadGis()).id.disableAutoSelect(); } catch { /* 離線時無法載入也沒關係：本機狀態由整頁重新載入清除 */ }
        },
    };
};
