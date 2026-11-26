// v6.2 教師端「學生系統」：發放學生帳號、發布每生資料、查看小組照顧（ADR-017～020）。
// STUDENT_API_BASE 沒設定時完全不出現。初始密碼只在畫面上出現一次，關閉視窗就從記憶體清掉。
import { h, fill, makeModal, $ } from './dom.js';
import { createStudentApi, StudentApiError } from '../sync/student-api.js';
import { CARE_BADGES } from '../core/care.js';
import { registrationsToEvents } from '../core/hw-helper.js';

const LS_AUTO = 'fhes.studentAutoPublish.v1';
const AUTO_DELAY_MS = 30_000;
const PULL_EVERY_MS = 5 * 60_000;            // 小老師登記：每 5 分鐘自動收取一次
const META_INBOX = 'studentInbox';           // S.meta.studentInbox = { [classId]: 已收取到的 seq }（只存游標，不存登記內容）
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 無痕視窗 */ } };

/**
 * @param {{ app, base: string, handoff?: {credential, nonce}, fetchFn?: typeof fetch }} opts
 * @returns {{ markDirty(): void, api, ready: Promise<void> }}
 */
export const initStudentAdminUI = ({ app, base, handoff, fetchFn }) => {
    const btn = $('student-system-btn');
    if (!base) { if (btn) btn.hidden = true; return { markDirty() {}, api: null, ready: Promise.resolve() }; }
    if (btn) btn.hidden = false;
    const api = createStudentApi({ base, fetchFn });
    const state = { status: 'connecting', message: '正在連線學生系統…', dirty: new Set(), published: new Map(), stale: null, slips: [] };
    let timer = null;

    const ready = (async () => {
        try { await api.connect(handoff); state.status = 'ok'; state.message = ''; }
        catch (e) { state.status = 'error'; state.message = e instanceof StudentApiError ? e.message : '無法連線學生系統'; }
        finally { handoff = null; }          // 憑證用完就丟
        if (modal.el.classList.contains('visible')) render();
        if (state.status === 'ok') { await pullAll(); setInterval(pullAll, PULL_EVERY_MS); }
    })();
    /** 第一次收取完成（或連不上）之後才 resolve；逾期愛心要等它（BUG-027）。最多等 20 秒 */
    const firstPull = Promise.race([ready.catch(() => {}), new Promise(ok => setTimeout(ok, 20_000))]);

    // ------------------------------------------------------------ 小老師登記：自動收取
    const inboxOf = () => ({ ...(app.S.meta[META_INBOX] || {}) });
    /** 收取一個班級；回傳新增的作業事件數。只收「已經連結過學生系統」的班級（有游標紀錄） */
    const pull = async (cls) => {
        const cursor = inboxOf()[cls.id] ?? 0;
        const { registrations, next } = await api.pullRegistrations(cls, cursor);
        let applied = 0;
        if (registrations.length) {
            const out = registrationsToEvents({ regs: registrations, hwEvents: app.S.hwEvents, assignments: app.S.hwAssignments, studentIds: app.studentsOf(cls.id).map(s => s.id), classId: cls.id });
            if (out.events.length) await app.addHomeworkEvents(out.events);
            applied = out.applied;
        }
        if (next !== cursor) await app.setMeta(META_INBOX, { ...inboxOf(), [cls.id]: next });
        state.lastPull = { at: Date.now(), applied };
        if (applied) { app.notify(`收到小老師登記 ${applied} 筆（${cls.name}）`); state.dirty.add(cls.id); }
        return applied;
    };
    let pulling = false;
    const pullAll = async () => {
        if (pulling || !api.connected) return;
        pulling = true;
        try {
            const linked = Object.keys(app.S.meta[META_INBOX] || {});
            for (const id of linked) { const cls = app.S.classes.find(x => x.id === id && !x.deleted); if (cls) { try { await pull(cls); } catch { /* 網路問題：下次再收 */ } } }
            if (lsGet(LS_AUTO) === '1') for (const id of [...state.dirty]) { const cls = app.S.classes.find(x => x.id === id && !x.deleted); if (cls && state.published.has(id)) await publish(cls, { quiet: true, skipPull: true }); }
        } finally { pulling = false; }
    };
    /** 第一次連結這個班級：建立游標（之後才會自動收取） */
    const link = async (cls) => { if (!(cls.id in (app.S.meta[META_INBOX] || {}))) await app.setMeta(META_INBOX, { ...inboxOf(), [cls.id]: 0 }); };

    const modal = makeModal('student-modal', { wide: true, label: '學生系統' });
    /** 初始密碼只能出現一次：不論怎麼關閉（按鈕、點背景、Esc），都從記憶體與 DOM 清掉 */
    const wipeSlips = () => { state.slips = []; $('student-slips')?.remove(); fill(modal.card); };
    new MutationObserver(() => { if (!modal.el.classList.contains('visible')) wipeSlips(); }).observe(modal.el, { attributes: true, attributeFilter: ['class'] });
    const close = () => modal.close();

    const classData = (cls) => ({ cls, ...Object.fromEntries(['students', 'events', 'hwAssignments', 'hwEvents', 'xpEvents', 'grants', 'specialItems'].map(k => [k, app.S[k]])) });
    const nameModeOf = (cls) => cls.studentSystem?.nameMode === 'seat' ? 'seat' : 'name';
    const say = (text, kind = 'info') => { const el = $('student-msg'); if (el) { el.textContent = text; el.dataset.kind = kind; } };

    const publish = async (cls, { overrideVersion, quiet = false, skipPull = false } = {}) => {
        try {
            await link(cls);
            if (!skipPull) { try { await pull(cls); } catch { /* 收取失敗不擋發布；下次再收 */ } }   // 先收小老師的登記，發布的資料才會包含它們
            const r = await api.publish(classData(cls), { today: app.localDate(), nameMode: nameModeOf(cls), overrideVersion, inboxSeq: inboxOf()[cls.id] ?? 0 });
            state.published.set(cls.id, { at: r.publishedAt, version: r.version, students: r.projection.students.length });
            state.dirty.delete(cls.id); state.stale = null;
            if (!quiet) app.notify(r.unchanged ? '學生系統的資料已經是最新的' : `已發布到學生系統（${r.projection.students.length} 位學生）`);
            return true;
        } catch (e) {
            if (e instanceof StudentApiError && e.status === 409) state.stale = { classId: cls.id, currentVersion: e.body?.currentVersion || 0 };
            if (!quiet) say(e.message || '發布失敗', 'error');
            return false;
        } finally { if (modal.el.classList.contains('visible')) render(); }
    };

    const markDirty = () => {
        const c = app.getCurrentClass?.();
        if (c) state.dirty.add(c.id);
        if (lsGet(LS_AUTO) !== '1' || !api.connected) return;
        clearTimeout(timer);
        timer = setTimeout(() => { for (const id of [...state.dirty]) { const cls = app.S.classes.find(x => x.id === id && !x.deleted); if (cls && state.published.has(id)) publish(cls, { quiet: true }); } }, AUTO_DELAY_MS);
    };

    const fmt = (t) => t ? `${app.localDate(t)} ${app.localTime(t)}` : '尚未發布';

    const accountsSection = async (cls) => {
        const box = h('div', { class: 'stu-accounts' }, h('p', { class: 'muted', text: '讀取帳號中…' }));
        try {
            await link(cls);
            const { accounts, publishedAt } = await api.listAccounts(cls);
            if (publishedAt && !state.published.has(cls.id)) state.published.set(cls.id, { at: publishedAt, version: null });
            const byStudent = new Map(accounts.map(a => [a.localStudentId, a]));
            const students = app.studentsOf(cls.id);
            const missing = students.filter(s => !byStudent.has(String(s.id)));
            const act = (a, action, label) => h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: label, onclick: async () => {
                if (action !== 'enable' && !confirm(action === 'reset' ? `重設 ${a.username} 的密碼？學生要用新的初始密碼登入，舊的登入會被登出。` : `停用 ${a.username}？學生會立即被登出、不能再登入。`)) return;
                try {
                    const r = await api.accountAction(cls, a.accountId, action);
                    if (action === 'reset') { const s = students.find(x => String(x.id) === a.localStudentId); state.slips = [{ seat: s?.seat, name: s?.name || '', username: r.username, password: r.initialPassword }]; }
                    render();
                } catch (e) { say(e.message, 'error'); }
            } });
            fill(box,
                h('div', { class: 'stu-row' },
                    h('strong', { text: `學生帳號（${accounts.length}/${students.length}）` }),
                    missing.length ? h('button', { id: 'stu-create-all', class: 'btn btn-primary btn-sm', type: 'button', text: `為 ${missing.length} 位學生建立帳號`, onclick: async () => {
                        try {
                            const r = await api.createAccounts(cls, missing.map(s => s.id));
                            const byId = new Map(students.map(s => [String(s.id), s]));
                            state.slips = r.created.map(c => ({ seat: byId.get(c.localStudentId)?.seat, name: byId.get(c.localStudentId)?.name || '', username: c.username, password: c.initialPassword }));
                            render();
                        } catch (e) { say(e.message, 'error'); }
                    } }) : null),
                h('p', { class: 'muted small', text: '小老師可以在學生系統登記全班作業（繳交、未繳交、未訂正、已訂正），但不能登記自己的；看不到分數和愛心。登記每 5 分鐘自動收到這台電腦。' }),
                h('table', { class: 'stu-table' },
                    h('thead', {}, h('tr', {}, h('th', { text: '座號' }), h('th', { text: '姓名' }), h('th', { text: '帳號' }), h('th', { text: '狀態' }), h('th', { text: '小老師' }), h('th', { text: '操作' }))),
                    h('tbody', {}, students.map(s => {
                        const a = byStudent.get(String(s.id));
                        return h('tr', { dataset: { sid: s.id } },
                            h('td', { text: s.seat ?? '' }), h('td', { class: 'left', text: s.name }),
                            h('td', { class: 'mono', text: a?.username || '—' }),
                            h('td', { text: !a ? '未建立' : a.status === 'disabled' ? '已停用' : a.mustChangePassword ? '等待首次登入' : '使用中' }),
                            h('td', {}, a ? h('input', { type: 'checkbox', class: 'stu-helper', 'aria-label': `${s.name} 是小老師`, checked: a.helper ? true : null, onchange: async (e) => {
                                const on = e.target.checked;
                                try { await api.setHelper(cls, a.accountId, on); app.notify(on ? `${s.name} 設為小老師` : `${s.name} 不再是小老師`); }
                                catch (err) { e.target.checked = !on; say(err.message, 'error'); }
                            } }) : null),
                            h('td', {}, a ? [act(a, 'reset', '重設密碼'), a.status === 'disabled' ? act(a, 'enable', '啟用') : act(a, 'disable', '停用')] : null));
                    }))));
        } catch (e) { fill(box, h('p', { class: 'error-text', text: e.message || '讀取帳號失敗' })); }
        return box;
    };

    const careSection = async (cls) => {
        const box = h('div', { class: 'stu-care' });
        try {
            const { groups } = await api.careSummary(cls);
            if (!groups.length) return fill(box, h('p', { class: 'muted', text: '發布後就能看到各小組的照顧情形。' }));
            fill(box, h('strong', { text: '小組照顧（只影響心情與裝飾，不影響 XP 或分數）' }),
                h('ul', { class: 'stu-care-list' }, groups.map(g => h('li', {},
                    `${g.name}：累計 ${g.care.total} 次、團隊星 ${g.care.teamStars} 顆、今天 ${g.care.today.participants}/${g.care.today.members} 人參與`,
                    g.care.badges.length ? ` · ${g.care.badges.map(id => CARE_BADGES.find(b => b.id === id)?.icon || '').join('')}` : ''))));
        } catch (e) { fill(box, h('p', { class: 'muted', text: e.message })); }
        return box;
    };

    const slipsView = () => {
        if (!state.slips.length) return null;
        const slips = h('div', { id: 'student-slips', class: 'stu-slips' },
            state.slips.map(s => h('div', { class: 'stu-slip' },
                h('div', { class: 'stu-slip-name', text: `${s.seat ?? ''} 號 ${s.name}` }),
                h('div', {}, '帳號：', h('span', { class: 'mono', text: s.username })),
                h('div', {}, '初始密碼：', h('span', { class: 'mono', text: s.password })),
                h('div', { class: 'stu-slip-note', text: '第一次登入後要改成自己的密碼。不要把密碼告訴別人。' }))));
        const old = $('student-slips'); if (old) old.remove();
        document.body.appendChild(slips);
        return h('div', { class: 'stu-new' },
            h('p', { class: 'warn-text', text: `新的帳號密碼（${state.slips.length} 位）只會顯示這一次。請現在列印或抄下來，關閉視窗後就看不到了。` }),
            h('table', { class: 'stu-table' }, h('tbody', {}, state.slips.map(s => h('tr', {}, h('td', { text: s.seat ?? '' }), h('td', { class: 'left', text: s.name }), h('td', { class: 'mono', text: s.username }), h('td', { class: 'mono', text: s.password }))))),
            h('button', { class: 'btn btn-secondary', type: 'button', text: '🖨️ 列印帳號單', onclick: () => window.print() }));
    };

    const render = async () => {
        const cls = app.getCurrentClass?.();
        if (!cls) return;
        const p = state.published.get(cls.id);
        const header = h('div', { class: 'stu-head' },
            h('h2', { text: `🎓 學生系統：${cls.name}` }),
            h('p', { id: 'student-status', class: 'stu-status', dataset: { status: state.status }, text: state.status === 'ok' ? '已連線學生系統' : state.message }),
            h('p', { class: 'muted small', text: '學生只看得到自己的分數（不含愛心）與作業，以及所屬小組的園區。照顧動物不會影響 XP、分數或收藏。' }));
        fill(modal.card, header,
            h('p', { id: 'student-msg', class: 'stu-msg', role: 'status' }),
            state.status !== 'ok' ? h('div', {}, h('button', { class: 'btn btn-secondary', type: 'button', text: '關閉', onclick: close })) : [
                h('div', { class: 'stu-publish' },
                    h('label', { class: 'stu-row' }, '學生畫面顯示：', h('select', { id: 'stu-name-mode', class: 'stu-select', onchange: async (e) => { cls.studentSystem = { ...(cls.studentSystem || {}), nameMode: e.target.value }; await app.saveClass(cls); state.dirty.add(cls.id); render(); } },
                        h('option', { value: 'name', text: '姓名', selected: nameModeOf(cls) === 'name' || null }), h('option', { value: 'seat', text: '只顯示座號', selected: nameModeOf(cls) === 'seat' || null }))),
                    h('div', { class: 'stu-row' },
                        h('button', { id: 'stu-publish', class: 'btn btn-primary', type: 'button', text: '📤 發布到學生系統', onclick: () => publish(cls) }),
                        h('span', { id: 'stu-published-at', class: 'muted', text: `上次發布：${fmt(p?.at)}` }),
                        h('button', { id: 'stu-pull', class: 'btn btn-secondary btn-sm', type: 'button', text: '📥 收取小老師登記', onclick: async () => {
                            try { await link(cls); const n = await pull(cls); if (!n) app.notify('沒有新的小老師登記'); render(); } catch (e) { say(e.message, 'error'); }
                        } }),
                        state.dirty.has(cls.id) ? h('span', { class: 'warn-text', text: '資料有變更，尚未發布' }) : null),
                    state.stale?.classId === cls.id ? h('div', { class: 'warn-box' },
                        h('p', { text: '學生系統上有另一台裝置發布的較新版本。如果這台的資料才是正確的，可以用這台的資料覆蓋。' }),
                        h('button', { class: 'btn btn-secondary', type: 'button', text: '以這台的資料覆蓋', onclick: () => publish(cls, { overrideVersion: state.stale.currentVersion + 1 }) })) : null,
                    h('label', { class: 'stu-check' }, h('input', { id: 'stu-auto', type: 'checkbox', checked: lsGet(LS_AUTO) === '1' || null, onchange: (e) => lsSet(LS_AUTO, e.target.checked ? '1' : '0') }),
                        ' 這台電腦：資料變更 30 秒後自動發布（只發布本次已手動發布過的班級）')),
                slipsView(),
                await accountsSection(cls),
                await careSection(cls),
                h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', type: 'button', text: '關閉', onclick: close })),
            ]);
    };

    btn?.addEventListener('click', async () => { modal.open(); await render(); });
    return { markDirty, api, ready, firstPull, publish, pull, pullAll };
};
