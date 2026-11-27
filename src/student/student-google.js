// P3：學生頁的 Google 登入按鈕（只有伺服器打開 FHES_STUDENT_GOOGLE 時才會用到）。
// 前端不驗證也不保存 ID token：拿到 credential 和這次的 nonce 就立刻交給學生系統 API，由伺服器驗簽、檢查 nonce、防重放。
// Google 的程式庫一次只認最後一次 initialize：同一個畫面只放一個按鈕，按鈕的用途由呼叫端決定（登入、建立帳號、連結、重設密碼）。
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

let gisPromise = null;
const loadGis = () => gisPromise || (gisPromise = new Promise((ok, no) => {
    if (window.google?.accounts?.id) { ok(window.google.accounts); return; }
    const sc = document.createElement('script');
    sc.src = GIS_SRC; sc.async = true;
    sc.onload = () => (window.google?.accounts?.id ? ok(window.google.accounts) : (gisPromise = null, no(new Error('gis-missing'))));
    sc.onerror = () => { gisPromise = null; sc.remove(); no(new Error('gis-network')); };
    document.head.appendChild(sc);
}));

const makeNonce = () => {
    const a = new Uint8Array(18); crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * 在 container 放一個 Google 按鈕。每按一次都是新的 nonce；onCredential({ credential, nonce }) 用完就丟。
 * 載入失敗（學校擋了 Google、離線）會丟錯，由呼叫端顯示「請用帳號密碼」。
 */
export const googleButton = async (container, clientId, onCredential, { text = 'signin_with' } = {}) => {
    const accounts = await loadGis();
    const init = () => {
        const nonce = makeNonce();
        accounts.id.initialize({
            client_id: clientId, nonce, auto_select: false, cancel_on_tap_outside: true,
            // 共用裝置：每次都顯示 Google 的帳號選擇畫面（和教師端 BUG-015 相同的設定）
            ux_mode: 'popup', itp_support: true, use_fedcm_for_button: false, button_auto_select: false,
            callback: (resp) => {
                init();                                            // 下一次按用新的 nonce
                if (resp && typeof resp.credential === 'string') onCredential({ credential: resp.credential, nonce });
            },
        });
    };
    init();
    if (!container.isConnected) return;
    accounts.id.renderButton(container, { type: 'standard', theme: 'filled_blue', size: 'large', text, shape: 'pill', logo_alignment: 'left', locale: 'zh-TW', width: 280 });
};

/** 登出時：共用電腦不要自動選上一個 Google 帳號 */
export const googleSignOut = () => { try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* 沒載入過就不用 */ } };
