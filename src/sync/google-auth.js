// Google Identity Services（瀏覽器 token model）。
// - 只在老師按下「連接」時才跳出授權視窗
// - 範圍只要 drive.file（只能存取本 App 建立或老師用本 App 開啟的檔案）
// - access token 只放在記憶體；不寫 localStorage / IndexedDB；過期就請老師再按一次「重新連線」
// - Client ID 是公開識別碼（不是密鑰），由老師在設定畫面輸入；client secret 永遠不需要也不應出現
import { SyncError } from './engine.js';

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const isValidClientId = (id) => /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(id || '').trim());

let gisPromise = null;
const loadGis = () => gisPromise || (gisPromise = new Promise((ok, no) => {
    if (window.google?.accounts?.oauth2) { ok(); return; }
    const sc = document.createElement('script');
    sc.src = GIS_SRC; sc.async = true; sc.defer = true;
    sc.onload = () => window.google?.accounts?.oauth2 ? ok() : no(new SyncError('network', '無法載入 Google 登入元件'));
    sc.onerror = () => { gisPromise = null; no(new SyncError('network', '無法載入 Google 登入元件（請確認網路）')); };
    document.head.appendChild(sc);
}));

export const createGoogleAuth = ({ clientId, now = () => Date.now() }) => {
    let token = null; let expiresAt = 0;
    return {
        /** 需在使用者點擊的事件中呼叫（瀏覽器才允許彈出視窗） */
        async connect({ prompt = '' } = {}) {
            if (!isValidClientId(clientId)) throw new SyncError('config', 'OAuth Client ID 格式不正確（應為 ….apps.googleusercontent.com）');
            await loadGis();
            const resp = await new Promise((ok, no) => {
                const client = window.google.accounts.oauth2.initTokenClient({
                    client_id: clientId, scope: SCOPE,
                    callback: (r) => r?.error ? no(new SyncError(r.error === 'access_denied' ? 'permission' : 'auth', r.error === 'access_denied' ? '已拒絕授權。' : `授權失敗：${r.error}`)) : ok(r),
                    error_callback: (e) => no(new SyncError('auth', e?.type === 'popup_closed' ? '授權視窗已關閉。' : '無法開啟授權視窗（請允許彈出視窗）。')),
                });
                client.requestAccessToken({ prompt });
            });
            if (window.google.accounts.oauth2.hasGrantedAllScopes && !window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
                throw new SyncError('permission', '沒有勾選「檔案存取」權限，無法同步。');
            }
            token = resp.access_token;
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
        async disconnect() {
            const t = token; token = null; expiresAt = 0;
            if (t && window.google?.accounts?.oauth2?.revoke) await new Promise(ok => window.google.accounts.oauth2.revoke(t, ok));
        },
    };
};
