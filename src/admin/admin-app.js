// 學生系統平台管理頁（D3a、T34）。只有後端 platform_admins 裡的 Google 身分能用；權限一律由後端判斷。
// 管理工作階段（Bearer，4 小時）只放在這個模組的記憶體：不寫入任何儲存空間、不放網址。重新整理就要重新登入。
// 核准重設後的初始密碼只顯示一次，換頁或重新整理清單就從畫面消失。
import { h, fill, $ } from '../ui/dom.js';
import { createGoogleSignIn, isValidClientId } from '../auth/google-signin.js';
import { currentClientId } from '../ui/auth-ui.js';
import { STUDENT_API_BASE } from '../config.js';

const root = String(STUDENT_API_BASE || '').replace(/\/+$/, '');
let token = null;
const status = (text, kind = '') => { const el = $('auth-status'); el.textContent = text; el.dataset.kind = kind; };
const say = (text, kind = 'info') => { const el = $('adm-msg'); el.textContent = text; el.dataset.kind = kind; };
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '');

const call = async (method, path, body) => {
    let r;
    try {
        r = await fetch(root + path, { method, credentials: 'omit', cache: 'no-store', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('連不上學生系統'); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && token) { token = null; location.replace(location.pathname); }
    if (!r.ok) throw new Error(data.message || `學生系統回應 ${r.status}`);
    return data;
};

const STATUS_TEXT = { pending: '待處理', approved: '已核准', rejected: '已拒絕', expired: '已作廢' };
const renderResets = async () => {
    const box = $('adm-resets');
    const { pending, recent } = await call('GET', '/api/admin/reset-requests');
    const row = (r, actions) => h('tr', { dataset: { request: r.id } },
        h('td', { text: fmt(r.createdAt) }), h('td', { class: 'left', text: r.className ?? '' }), h('td', { class: 'mono', text: r.username ?? '' }),
        h('td', { text: r.teacherCount > 1 ? `${r.teacherCount} 位老師的班級` : '1 位老師' }), h('td', { text: STATUS_TEXT[r.status] || r.status }), h('td', {}, actions));
    fill(box,
        pending.length ? h('table', { class: 'adm-table', id: 'adm-pending' },
            h('thead', {}, h('tr', {}, ['送出時間', '班級', '學生帳號', '這位學生在', '狀態', '操作'].map(t => h('th', { text: t })))),
            h('tbody', {}, pending.map(r => row(r, [
                h('button', { class: 'adm-btn adm-primary', type: 'button', text: '核准並產生新密碼', onclick: async () => {
                    const extra = r.teacherCount > 1 ? `\n注意：這位學生也在其他老師的班上；新密碼可以登入他所有的班級。` : '';
                    if (!confirm(`核准「${r.className}」的 ${r.username} 重設密碼？學生目前的登入會全部登出。${extra}`)) return;
                    try {
                        const out = await call('POST', `/api/admin/reset-requests/${encodeURIComponent(r.id)}/approve`, {});
                        await renderResets();
                        $('adm-resets').prepend(h('div', { id: 'adm-new-password', class: 'adm-new' },
                            h('p', { class: 'adm-warn', text: '新的初始密碼只會顯示這一次，請交給送出申請的老師；學生登入後必須改成自己的密碼。' }),
                            h('p', {}, '帳號：', h('span', { class: 'mono', text: out.username }), '　初始密碼：', h('span', { class: 'mono', id: 'adm-initial-password', text: out.initialPassword }))));
                    } catch (e) { say(e.message, 'error'); }
                } }),
                h('button', { class: 'adm-btn', type: 'button', text: '拒絕', onclick: async () => {
                    if (!confirm('拒絕這筆申請？')) return;
                    try { await call('POST', `/api/admin/reset-requests/${encodeURIComponent(r.id)}/reject`, {}); await renderResets(); } catch (e) { say(e.message, 'error'); }
                } }),
            ])))) : h('p', { class: 'adm-muted', text: '沒有待處理的申請。' }),
        recent.length ? h('details', {}, h('summary', { text: `最近處理過的（${recent.length}）` }),
            h('table', { class: 'adm-table' }, h('tbody', {}, recent.map(r => row(r, fmt(r.decidedAt)))))) : null);
};

const renderTeachers = async () => {
    const { teachers } = await call('GET', '/api/admin/teachers');
    fill($('adm-teachers'), h('table', { class: 'adm-table' },
        h('thead', {}, h('tr', {}, ['老師代號', '註冊方式', '開始使用', '班級', '狀態', '操作'].map(t => h('th', { text: t })))),
        h('tbody', {}, teachers.map(t => h('tr', { dataset: { teacher: t.id } },
            h('td', { class: 'mono', text: t.id }), h('td', { text: t.signup === 'self' ? '自助註冊' : '名單' }), h('td', { text: fmt(t.createdAt) }),
            h('td', { class: 'left', text: t.classes.join('、') || '（還沒有班級）' }), h('td', { text: t.status === 'suspended' ? '已停權' : '使用中' }),
            h('td', {}, h('button', { class: 'adm-btn', type: 'button', text: t.status === 'suspended' ? '恢復' : '停權', onclick: async () => {
                const suspend = t.status !== 'suspended';
                if (suspend && !confirm(`停權老師 ${t.id}？他會立即被登出，他的邀請碼與綁定碼也會失效。學生的資料不會被刪除。`)) return;
                try { await call('POST', `/api/admin/teachers/${encodeURIComponent(t.id)}/${suspend ? 'suspend' : 'unsuspend'}`, {}); await renderTeachers(); }
                catch (e) { say(e.message, 'error'); }
            } })))))));
};

const renderAudit = async () => {
    const { events } = await call('GET', '/api/admin/audit');
    fill($('adm-audit'), h('details', {}, h('summary', { text: `展開（${events.length} 筆）` }),
        h('table', { class: 'adm-table adm-audit' },
            h('thead', {}, h('tr', {}, ['時間', '誰', '動作', '對象'].map(t => h('th', { text: t })))),
            h('tbody', {}, events.map(e => h('tr', {}, h('td', { text: fmt(e.ts) }), h('td', { class: 'mono', text: `${e.actorKind}${e.actorId ? ` ${e.actorId}` : ''}` }), h('td', { class: 'mono', text: e.action }), h('td', { class: 'mono', text: e.target ?? '' })))))));
};

const start = async () => {
    $('auth-gate').hidden = true; $('adm-app').hidden = false;
    $('adm-logout').addEventListener('click', async () => { try { await call('POST', '/api/admin/logout', {}); } catch { /* 已失效也沒關係 */ } token = null; location.replace(location.pathname); });
    try { await renderResets(); await renderTeachers(); await renderAudit(); } catch (e) { say(e.message, 'error'); }
};

(async () => {
    if (!root) { status('這個網站沒有設定學生系統（STUDENT_API_BASE），管理頁不能使用。', 'error'); return; }
    const clientId = currentClientId();
    if (!isValidClientId(clientId)) { status('尚未設定 Google 登入（OAuth Client ID）。', 'error'); return; }
    const signIn = createGoogleSignIn({ clientId });
    try {
        await signIn.mount($('gsi-button'), {
            onVerifying: () => status('正在驗證 Google 登入…', 'info'),
            onResult: async ({ error, handoff }) => {
                if (error) { status(`登入失敗：${error.message}`, 'error'); return; }
                try {
                    const r = await fetch(`${root}/api/admin/session`, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: handoff.credential, nonce: handoff.nonce }) });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) { status(data.message || '沒有管理權限', 'error'); return; }
                    token = data.token;
                    status('');
                    await start();
                } catch { status('連不上學生系統', 'error'); }
            },
        });
    } catch { status('無法載入 Google 登入元件，請確認網路後重新整理。', 'error'); }
})();
