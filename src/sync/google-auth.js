// Google 試算表授權（Authorization）：Google Identity Services token model。
// 與「登入（Authentication）」分開（src/auth/google-signin.js）：
// - 只在老師按下「連接／重新連線」時才跳出授權視窗
// - 範圍：drive.file（只能存取本 App 建立或老師用本 App 開啟的檔案）＋ openid（只用來確認授權帳號的 sub）
// - 授權帳號必須等於登入帳號：login_hint 預選登入帳號，取得 token 後用 userinfo 端點（Bearer 標頭，不放網址）
//   比對 sub；不同就撤銷 token 並拒絕（不能只看登入畫面的 email 推斷）
// - access token 只放在記憶體；不寫 localStorage / IndexedDB；過期就請老師再按一次「重新連線」
// - Client ID 是公開識別碼（不是密鑰）；client secret 永遠不需要也不應出現
import { SyncError } from './engine.js';
import { loadGis, isValidClientId } from '../auth/google-signin.js';
/**
 * Google 在彈出視窗內顯示錯誤頁（例如「已封鎖存取權」403 access_denied：帳號不在 OAuth 測試使用者名單）時，
 * 不會把錯誤回傳給 App，App 只會收到 popup_closed。所以關閉訊息要把這種情況一起說清楚（BUG-013，真實 Google 驗收時發現）。
 */
export const POPUP_CLOSED_TEXT = '授權視窗已關閉，沒有完成授權。若 Google 視窗顯示「已封鎖存取權」或「403 access_denied」，代表這個帳號不在 OAuth 同意畫面的「測試使用者」名單，請管理者加入後再試（見設定說明）。';

export { isValidClientId };
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPE = `openid ${DRIVE_FILE_SCOPE}`;
export const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * @param {{ clientId: string, expectedSub: string, loginHint?: string, now?: () => number, fetchFn?: typeof fetch }} opts
 *   expectedSub：目前登入帳號的 sub（必填；沒有登入就不能授權試算表）
 */
export const createGoogleAuth = ({ clientId, expectedSub, loginHint = '', now = () => Date.now(), fetchFn = (...a) => fetch(...a) }) => {
    let token = null; let expiresAt = 0;
    const revoke = (t) => new Promise(ok => { try { window.google?.accounts?.oauth2?.revoke ? window.google.accounts.oauth2.revoke(t, ok) : ok(); } catch { ok(); } });
    return {
        /** 需在使用者點擊的事件中呼叫（瀏覽器才允許彈出視窗） */
        async connect({ prompt = '' } = {}) {
            if (!isValidClientId(clientId)) throw new SyncError('config', 'OAuth Client ID 格式不正確（應為 ….apps.googleusercontent.com）');
            if (!expectedSub) throw new SyncError('auth', '請先登入 Google 帳號。');
            try { await loadGis(); } catch { throw new SyncError('network', '無法載入 Google 授權元件（請確認網路）'); }
            const resp = await new Promise((ok, no) => {
                const client = window.google.accounts.oauth2.initTokenClient({
                    client_id: clientId, scope: SCOPE, hint: loginHint || expectedSub, include_granted_scopes: false,
                    callback: (r) => r?.error ? no(new SyncError(r.error === 'access_denied' ? 'permission' : 'auth', r.error === 'access_denied' ? '已拒絕授權。' : `授權失敗：${r.error}`)) : ok(r),
                    error_callback: (e) => no(new SyncError('auth', e?.type === 'popup_closed' ? POPUP_CLOSED_TEXT : '無法開啟授權視窗（請允許彈出視窗）。')),
                });
                client.requestAccessToken({ prompt, login_hint: loginHint || expectedSub });
            });
            const t = resp.access_token;
            if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_FILE_SCOPE)) {
                if (t) await revoke(t);
                throw new SyncError('permission', '沒有勾選「檔案存取」權限，無法同步。');
            }
            // 確認授權帳號＝登入帳號（Bearer 標頭；token 不出現在網址）
            let info;
            try {
                const r = await fetchFn(USERINFO_URL, { headers: { Authorization: `Bearer ${t}` }, credentials: 'omit', cache: 'no-store' });
                if (!r.ok) throw new SyncError(r.status === 401 ? 'auth' : 'unknown', '無法確認授權的 Google 帳號，請再試一次。');
                info = await r.json();
            } catch (e) { await revoke(t); throw e instanceof SyncError ? e : new SyncError('network', '無法確認授權的 Google 帳號（請確認網路）。'); }
            if (!info || info.sub !== expectedSub) {
                await revoke(t);
                throw new SyncError('account-mismatch', '授權的 Google 帳號與目前登入的帳號不同，已拒絕。請選擇登入中的同一個帳號。');
            }
            token = t;
            expiresAt = now() + (Number(resp.expires_in) || 3600) * 1000;
            return { expiresAt };
        },
        /** 給 Sheets adapter 用；過期丟 auth 錯誤（不會自動跳視窗） */
        async getToken() {
            if (!token || now() > expiresAt - 60_000) throw new SyncError('auth', 'Google 授權已過期，請按「重新連線」。');
            return token;
        },
        /** token 被 Google 拒絕（401）時清掉 */
        invalidate() { token = null; expiresAt = 0; },
        isConnected: () => !!token && now() < expiresAt - 60_000,
        expiresAt: () => expiresAt,
        accountSub: () => expectedSub,
        async disconnect() {
            const t = token; token = null; expiresAt = 0;
            if (t) await revoke(t);
        },
    };
};
