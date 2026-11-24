// 登入畫面（方案 A：老師必須先用 Google 帳號登入才能進入）、帳號選單、工作階段看門狗。
// 未登入時：不開啟任何帳號資料庫、不渲染任何班級／學生／成績／作業／圖鑑資料（ADR-011）。
// 登出／切換帳號／工作階段到期：停止同步、撤銷記憶體中的 token、整頁重新載入 → 記憶體中所有前一位老師的狀態都清空。
import { h, makeModal, fill } from './dom.js';
import { createGoogleSignIn, isValidClientId, SESSION_MAX_MS } from '../auth/google-signin.js';
import { GOOGLE_CLIENT_ID } from '../config.js';

const LS_CLIENT_ID = 'fhes_google_client_id';          // 公開識別碼（非密鑰）；只有 src/config.js 未設定時才用
const SS_NOTICE = 'fhes_auth_notice';                  // 重新載入後要顯示的提示代碼（不含任何個資或憑證）
const CHANNEL = 'fhes-auth';

const NOTICES = {
    'signed-out': '已登出。這台電腦上的班級資料不會顯示，直到再次登入。',
    switch: '請選擇要使用的 Google 帳號。',
    expired: '登入已超過 12 小時，為了保護學生資料，請重新登入。',
    'other-tab': '你在另一個分頁登出了，這個分頁也已鎖定。',
    wiped: '已登出，並移除這台電腦上此帳號的本機資料。',
};
const ERROR_TEXT = {
    signature: '登入驗證失敗：憑證簽章不正確，未進入系統。',
    iss: '登入驗證失敗：憑證不是 Google 發出的，未進入系統。',
    aud: '登入驗證失敗：憑證不是發給本系統的，未進入系統。',
    alg: '登入驗證失敗：不接受的憑證格式，未進入系統。',
    kid: '登入驗證失敗：找不到 Google 簽章金鑰，請稍後再試。',
    malformed: '登入驗證失敗：憑證格式錯誤，未進入系統。',
    expired: 'Google 登入憑證已過期，請再登入一次。',
    iat: '登入驗證失敗：電腦時間可能不正確，請校正時間後再試。',
    nonce: '登入憑證無效（可能被重複使用），請再登入一次。',
    sub: '登入驗證失敗：缺少帳號識別碼。',
    jwks: '無法連線到 Google 驗證登入，請確認網路後再試。',
    network: '無法連線到 Google 驗證登入，請確認網路後再試。',
    config: '登入設定不完整（OAuth Client ID）。',
};

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* 忽略 */ } };
const ssTake = (k) => { try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch { return null; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* 忽略 */ } };

/** 目前使用的 OAuth Client ID：部署設定（src/config.js）優先，其次是這台電腦上老師輸入的 */
export const currentClientId = () => (isValidClientId(GOOGLE_CLIENT_ID) ? GOOGLE_CLIENT_ID : (lsGet(LS_CLIENT_ID) || '')).trim();

/**
 * 顯示登入畫面，直到 Google 登入「驗證通過」才 resolve（回傳 { identity, signIn, clientId }）。
 * 取消、失敗、離線：停在登入畫面，不 resolve。
 */
export const waitForSignIn = ({ $ }) => new Promise((resolve) => {
    document.body.classList.add('locked');
    const status = $('auth-status'); const btnBox = $('gsi-button'); const setup = $('auth-setup');
    const say = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind; };
    const notice = ssTake(SS_NOTICE);
    if (notice && NOTICES[notice]) say(NOTICES[notice], 'info');

    let mounted = false;
    const mount = async () => {
        const clientId = currentClientId();
        setup.hidden = !!clientId && isValidClientId(GOOGLE_CLIENT_ID);
        $('auth-client-id').value = isValidClientId(GOOGLE_CLIENT_ID) ? '' : clientId;
        if (!isValidClientId(clientId)) { say('尚未設定 Google 登入（OAuth Client ID）。請依下方說明輸入；這是公開識別碼，不是密碼。', 'warn'); fill(btnBox); return; }
        if (!navigator.onLine) { say('目前沒有網路。登入需要連線到 Google；你的資料仍安全保存在這台電腦，恢復網路後就能登入。', 'warn'); return; }
        const signIn = createGoogleSignIn({ clientId });
        try {
            await signIn.mount(btnBox, {
                onVerifying: () => say('正在驗證 Google 登入…', 'info'),
                onResult: ({ identity, error }) => {
                    if (error) { say(ERROR_TEXT[error.code] || `登入失敗：${error.message}`, 'error'); return; }
                    say('');
                    document.body.classList.remove('locked');
                    resolve({ identity, signIn, clientId });
                },
            });
            mounted = true;
            if (!notice) say('');
        } catch {
            say('無法載入 Google 登入元件。請確認網路，或稍後重新整理。你的資料仍安全保存在這台電腦。', 'error');
        }
    };
    window.addEventListener('online', () => { if (!mounted) mount(); });
    $('auth-client-save').addEventListener('click', () => {
        const v = $('auth-client-id').value.trim();
        if (!isValidClientId(v)) { say('Client ID 格式不正確：應為「數字-英數.apps.googleusercontent.com」。不要貼用戶端密鑰。', 'error'); return; }
        lsSet(LS_CLIENT_ID, v); mounted = false; mount();
    });
    mount();
});

/** 整頁重新載入到乾淨狀態（清掉網址上的參數與 hash）；notice：重新載入後的提示代碼 */
export const hardReload = (notice) => {
    if (notice) ssSet(SS_NOTICE, notice);
    window.location.replace(window.location.pathname);
};

/**
 * 登入後：帳號按鈕與選單、跨分頁登出、工作階段到期。
 * hooks：{ stopSync(): Promise, flush(): Promise, pendingCount(): Promise<number>, wipeLocal(): Promise, openSync(), now() }
 */
export const initAccountUI = ({ $, identity, signIn, hooks }) => {
    const now = hooks.now || (() => Date.now());
    let locking = false;
    const bc = (() => { try { return new BroadcastChannel(CHANNEL); } catch { return null; } })();

    const lock = async (notice, { broadcast = true, wipe = false } = {}) => {
        if (locking) return; locking = true;
        try { await hooks.stopSync(); } catch { /* 繼續鎖定 */ }
        if (wipe) { try { await hooks.wipeLocal(); } catch (e) { alert(`移除本機資料失敗：${e?.message || e}`); } }
        if (broadcast) { try { bc?.postMessage({ type: 'signout', account: hooks.accountTag }); } catch { /* 忽略 */ } }
        await signIn.signOut();
        // 先在原地清掉：記憶體中的資料、所有資料畫面與對話框（不依賴重新載入成功）
        try { hooks.wipeMemory?.(); } catch { /* 繼續鎖定 */ }
        document.querySelectorAll('.app-screen, .modal, #record-overlay').forEach(e => e.remove());
        document.body.classList.add('locked');
        const status = document.getElementById('auth-status');
        // 舊頁面的登入按鈕不能再用（它屬於即將被丟掉的頁面）：先移除，等新頁面載入後才出現新的按鈕
        const box = document.getElementById('gsi-button'); if (box) fill(box);
        if (navigator.onLine) { if (status) { status.textContent = '正在登出…'; status.dataset.kind = 'info'; } hardReload(notice); return; }
        // 離線：無法重新載入（也無法再登入）；保持鎖定，恢復網路後自動重新載入到乾淨的登入畫面
        if (status) { status.textContent = `${NOTICES[notice] || ''} 目前離線，恢復網路後即可重新登入。`; status.dataset.kind = 'warn'; }
        window.addEventListener('online', () => hardReload(notice), { once: true });
    };
    // 另一個分頁登出同一個帳號 → 這裡也鎖定
    if (bc) bc.onmessage = (ev) => { if (ev.data?.type === 'signout' && ev.data.account === hooks.accountTag) lock('other-tab', { broadcast: false }); };

    // 工作階段到期（看門狗：每 30 秒、切回分頁時檢查）
    const check = () => { if (now() >= identity.sessionExpiresAt) lock('expired'); };
    setInterval(check, 30_000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });

    const label = identity.name || identity.email || 'Google 帳號';
    const chip = h('button', { id: 'account-btn', class: 'account-chip', title: '帳號：登出、切換帳號、重新授權', 'aria-haspopup': 'dialog' },
        h('span', { class: 'account-avatar', 'aria-hidden': 'true', text: (label.trim()[0] || 'G').toUpperCase() }),
        h('span', { class: 'account-name', text: identity.email || label }));
    { const slot = $('account-slot'); if (slot) fill(slot, chip); }

    const modal = makeModal('account-modal', { label: '帳號' });
    const open = async () => {
        const pend = await hooks.pendingCount().catch(() => 0);
        fill(modal.card,
            h('h2', { text: '👤 目前登入的帳號' }),
            h('div', { class: 'account-id' },
                h('span', { class: 'account-avatar big', 'aria-hidden': 'true', text: chip.firstChild.textContent }),
                h('div', {}, h('strong', { id: 'account-name', text: identity.name || '（未提供名稱）' }), h('div', { id: 'account-email', class: 'muted', text: identity.email || '' }),
                    h('div', { class: 'muted small', text: `已由 Google 驗證・本次登入有效到 ${new Date(identity.sessionExpiresAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` }))),
            pend ? h('p', { class: 'hw-banner teacher', text: `還有 ${pend} 筆資料尚未同步到雲端。登出後會保留在這台電腦（此帳號的資料區），下次用同一個帳號登入會繼續同步。` }) : null,
            h('div', { class: 'modal-actions wrap' },
                h('button', { class: 'btn btn-primary', id: 'acct-signout', text: '登出', onclick: () => lock('signed-out') }),
                h('button', { class: 'btn btn-secondary', id: 'acct-switch', text: '切換帳號', onclick: () => lock('switch') }),
                h('button', { class: 'btn btn-secondary', id: 'acct-reauth', text: '☁️ 雲端重新授權', onclick: () => { modal.close(); hooks.openSync(); } })),
            h('details', { class: 'hw-hist' }, h('summary', { text: '共用電腦：登出並移除這台電腦上此帳號的資料' }),
                h('p', { class: 'muted', text: '適合在學校共用電腦上使用。會先下載一份備份，再刪除這台電腦上「此帳號」的班級資料。Google 試算表與其他電腦的資料不受影響。' }),
                h('button', { class: 'btn btn-danger', id: 'acct-wipe', text: '下載備份後移除並登出', onclick: async () => {
                    const p = await hooks.pendingCount().catch(() => 0);
                    const warn = p ? `\n\n⚠ 還有 ${p} 筆尚未同步到雲端，移除後只能從剛下載的備份找回。` : '';
                    if (!confirm(`確定要移除這台電腦上此帳號的所有班級資料並登出？${warn}`)) return;
                    if (!confirm('再次確認：移除後無法從這台電腦復原（備份檔會先下載）。')) return;
                    await hooks.backup();
                    lock('wiped', { wipe: true });
                } })),
            h('details', { class: 'hw-hist' }, h('summary', { text: '安全說明' }),
                h('ul', {}, [
                    '每個 Google 帳號在這台電腦有各自的資料區；登入 A 帳號看不到 B 帳號的班級。',
                    '登入是在瀏覽器中驗證 Google 簽章（沒有伺服器）。它能防止未登入的人從畫面進入，但無法阻止能操作這台電腦開發者工具的人讀取瀏覽器資料。',
                    '本機資料沒有加密。共用電腦請登出，或使用「移除這台電腦上此帳號的資料」，或為每位老師使用不同的電腦帳號／瀏覽器設定檔。',
                    '雲端資料的權限由 Google 試算表控管：只有你的 Google 帳號（以及你自己分享的人）能讀寫。',
                ].map(t => h('li', { text: t })))),
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => modal.close() })));
        modal.open();
    };
    chip.addEventListener('click', open);
    return { lock, open, sessionMaxMs: SESSION_MAX_MS };
};
