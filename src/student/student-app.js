// v6.2 學生學習中心（student.html）。手機優先；與學生系統 API 同源。
// 安全：不在瀏覽器存任何資料（只有 HttpOnly Cookie）；CSRF token、班級清單、目前選的班都只放記憶體；DOM 一律 textContent（不用 HTML 字串）。
// 學生只能看到自己的分數與作業、所屬小組的園區；照顧結果由後端裁決，前端不計算任何 XP／分數／成長。
// P3（多班級）：一個人可以在好幾個班。每個請求都走 /api/student/classes/<我在這班的代號>/…，由後端核對成員資格。
// 切換班級時先清空畫面，並用 request generation（gen）丟掉切換前發出、比較晚才回來的回應（T30）。
import { h, fill } from '../ui/dom.js';
import { googleButton, googleSignOut } from './student-google.js';
import { SIMPLE, SIMPLE_ICON, simpleLabel, simpleOf } from '../core/homework.js';
import { CARE_ACTIONS, MOODS, CARE_BADGES } from '../core/care.js';
import { catalogById, worldById, rarityById } from '../data/catalog.js';
import { sceneCreature } from '../art/student-art.js';
import { sceneSVG, placeInScene } from '../art/scenes.js';

const root = document.getElementById('app');
const STALE_DAYS = 3;
let csrf = null;
let tab = 'growth';
let me = null;                 // /api/student/me：班級清單、待確認的申請、登入方式
let current = null;            // 目前的班級（我在這班的成員代號）
let gen = 0;                   // 每換一次畫面或班級就 +1；舊的回應回來時 gen 已經不同 → 丟掉
let joinCode = '';             // 從 QR 連結 #join= 讀到的邀請碼（只放記憶體，網址列已清掉）
let gcfg = null;               // 伺服器打開學生 Google 登入時：{ clientId }
const STALE = Symbol('stale');
const myClass = () => me?.classes?.find(c => c.id === current) || null;
const isHelper = () => !!myClass()?.helper;   // 只決定要不要顯示「登記作業」分頁；真正的權限由後端每次檢查
const classPath = (sub) => `/api/student/classes/${encodeURIComponent(current)}/${sub}`;
/** 換畫面：之前還沒回來的請求全部作廢 */
const screen = (...nodes) => { gen++; fill(root, ...nodes); }
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------ API
class ApiError extends Error { constructor(status, body) { super(body?.message || `錯誤 ${status}`); this.status = status; this.body = body; } }
const api = async (method, path, body) => {
    let r;
    try {
        r = await fetch(path, {
            method, credentials: 'same-origin', cache: 'no-store',
            headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'x-fhes-csrf': csrf } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    } catch { throw new ApiError(0, { message: '連不上伺服器，請檢查網路後再試。' }); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
};
const newKey = () => (crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')).replace(/[^A-Za-z0-9_-]/g, '');

// ------------------------------------------------------------ 共用元件
const msg = (text, kind = 'info') => h('p', { class: `stu-note stu-note-${kind}`, role: kind === 'error' ? 'alert' : 'status', text });
const fmtTime = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const staleNote = (publishedAt) => {
    if (!publishedAt) return null;
    const days = (Date.now() - publishedAt) / 86400_000;
    return days > STALE_DAYS ? msg(`老師上次更新資料是 ${fmtTime(publishedAt)}，這裡顯示的可能不是最新的。`, 'warn') : h('p', { class: 'stu-updated', text: `資料更新：${fmtTime(publishedAt)}` });
};
const fail = async (e) => {
    if (e === STALE) return;
    if (e.status === 401) { clearAll(); showLogin('登入已經過期，請重新登入。'); return; }
    if (e.status === 403 && e.body?.error === 'password_change_required') { showChangePassword(true); return; }
    // 這一班已經不能用了（被老師移出、退出、班級關閉）：重新整理班級清單
    if (e.status === 404 && current && e.body?.error === 'not_found') { await refreshMe(); return route('你已經不在這個班級了。'); }
    screen(msg(e.message || '發生錯誤', 'error'), h('button', { class: 'stu-btn', type: 'button', text: '重新整理', onclick: () => boot() }));
};
const clearAll = () => { csrf = null; me = null; current = null; tab = 'growth'; gen++; };

// ------------------------------------------------------------ 登入
const showLogin = (notice = '') => {
    const user = h('input', { id: 'stu-user', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', inputmode: 'latin', required: true, maxlength: 32 });
    const pass = h('input', { id: 'stu-pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
    const out = h('div', { id: 'stu-login-msg' }, notice ? msg(notice, 'info') : null);
    const btn = h('button', { class: 'stu-btn stu-btn-primary', type: 'submit', text: '登入' });
    const form = h('form', { class: 'stu-card stu-login', onsubmit: async (e) => {
        e.preventDefault(); btn.disabled = true; fill(out, msg('登入中…'));
        try {
            const r = await api('POST', '/api/student/login', { username: user.value.trim(), password: pass.value });
            csrf = r.csrf; pass.value = '';
            if (r.mustChangePassword) showChangePassword(true); else { await refreshMe(); route(); }
        } catch (err) { fill(out, msg(err.message, 'error')); btn.disabled = false; pass.value = ''; pass.focus(); }
    } },
    h('h1', { text: '🌟 學生學習中心' }),
    joinCode ? msg('登入後就會幫你填好班級邀請碼。', 'info') : null,
    h('label', { for: 'stu-user', text: '帳號' }), user,
    h('label', { for: 'stu-pass', text: '密碼' }), pass,
    out, btn,
    gcfg ? googleLoginBox(out) : null,
    h('p', { class: 'stu-hint', text: gcfg
        ? '帳號和第一次的密碼由老師發給你。忘記密碼：連結過 Google 的同學可以用 Google 登入後自己設新密碼，其他同學請找老師。用共用的電腦時，用完記得按「登出」。'
        : '帳號和第一次的密碼由老師發給你。忘記密碼請找老師重設。用學校或家裡共用的電腦時，用完記得按「登出」。' }));
    screen(form);
    user.focus();
};

/** 登入畫面下方的 Google 區塊。沒連結過的 Google 帳號：先說明，學生自己決定要不要「用這個 Google 帳號建立新帳號」 */
const googleLoginBox = (out) => {
    const box = h('div', { class: 'stu-google', id: 'stu-google' });
    const draw = (create) => {
        const slot = h('div', { class: 'stu-gsi', id: 'stu-gsi' });
        fill(box, h('p', { class: 'stu-or', text: '或' }),
            create ? msg('這個 Google 帳號還沒有學生帳號。已經有老師給的帳號？請先用帳號密碼登入，再到「帳號」連結 Google。新同學：再按一次下面的按鈕，用 Google 建立新帳號。', 'info') : null,
            slot);
        googleButton(slot, gcfg.clientId, async ({ credential, nonce }) => {
            fill(out, msg('登入中…'));
            try {
                const r = await api('POST', '/api/student/google', { credential, nonce, ...(create ? { create: true } : {}) });
                csrf = r.csrf; await refreshMe(); route(r.created ? '帳號建立好了！輸入老師給的代碼就可以加入班級。' : '');
            } catch (err) {
                if (err.body?.error === 'not_linked') { fill(out); draw(true); return; }
                fill(out, msg(err.message, 'error'));
            }
        }, { text: create ? 'signup_with' : 'signin_with' }).catch(() => fill(box, msg('Google 登入現在不能用（可能被學校網路擋住），請用帳號密碼登入。', 'warn')));
    };
    draw(false);
    return box;
};

const showChangePassword = (first = false) => {
    const cur = h('input', { id: 'stu-cur', type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
    const nw = h('input', { id: 'stu-new', type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 64 });
    const nw2 = h('input', { id: 'stu-new2', type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 64 });
    const out = h('div', {});
    const form = h('form', { class: 'stu-card stu-login', onsubmit: async (e) => {
        e.preventDefault();
        if (nw.value !== nw2.value) { fill(out, msg('兩次輸入的新密碼不一樣。', 'error')); return; }
        try {
            const r = await api('POST', '/api/student/password', { currentPassword: cur.value, newPassword: nw.value });
            csrf = r.csrf; await refreshMe(); route('密碼改好了！以後請用新密碼登入。');
        } catch (err) { if (err.status === 401) return fail(err); fill(out, msg(err.message, 'error')); }
    } },
    h('h1', { text: first ? '🔐 設定你的新密碼' : '🔐 更改密碼' }),
    first ? h('p', { text: '第一次登入，請把老師給的密碼換成只有你知道的密碼。' }) : null,
    h('label', { for: 'stu-cur', text: first ? '老師給的密碼' : '目前的密碼' }), cur,
    h('label', { for: 'stu-new', text: '新密碼' }), nw,
    h('label', { for: 'stu-new2', text: '再輸入一次新密碼' }), nw2,
    h('ul', { class: 'stu-rules' }, h('li', { text: '至少 8 個字' }), h('li', { text: '不要包含帳號，也不要用 12345678 這種太簡單的' }), h('li', { text: '不要告訴別人，包括好朋友' })),
    out,
    h('button', { class: 'stu-btn stu-btn-primary', type: 'submit', text: '儲存新密碼' }),
    first ? h('button', { class: 'stu-btn', type: 'button', text: '登出', onclick: logout }) : h('button', { class: 'stu-btn', type: 'button', text: '取消', onclick: () => showAccount() }));
    screen(form);
    cur.focus();
};

const logout = async () => {
    try { await api('POST', '/api/student/logout', {}); } catch { /* 已失效也一樣回到登入畫面 */ }
    clearAll(); joinCode = ''; googleSignOut(); showLogin('已經登出。');
};
const refreshMe = async () => { try { me = await api('GET', '/api/student/me'); csrf = me.csrf; } catch { /* 下一個請求會處理 */ } };

/** 登入後去哪裡：要改密碼 → 改密碼；有邀請碼或還沒有班級 → 我的班級；否則進入（保留原本選的班） */
const route = (notice = '') => {
    if (!me) return showLogin();
    if (me.mustChangePassword) return showChangePassword(true);
    if (!me.classes.some(c => c.id === current)) current = me.classes[0]?.id || null;
    if (joinCode || !current) return showClasses(notice);
    return showMain(notice);
};
const switchClass = (id) => {
    if (id === current) return;
    current = id;
    if (tab === 'helper' && !isHelper()) tab = 'growth';
    showMain();                                       // showMain 會先清空畫面、gen+1
};

// ------------------------------------------------------------ 主畫面
const TABS = [['growth', '🌱', '我的成長'], ['homework', '📚', '我的作業'], ['zoo', '🐾', '小組園區'], ['help', '❓', '說明']];
const HELPER_TAB = ['helper', '📝', '登記作業'];

const header = () => h('header', { class: 'stu-header' },
    h('strong', { text: '🌟 學生學習中心' }),
    h('span', { class: 'stu-header-actions' },
        h('button', { id: 'stu-classes-btn', class: 'stu-link', type: 'button', text: '我的班級', onclick: async () => { await refreshMe(); if (me) showClasses(); } }),
        h('button', { id: 'stu-account-btn', class: 'stu-link', type: 'button', text: '帳號', onclick: () => showAccount() }),
        h('button', { id: 'stu-logout', class: 'stu-link', type: 'button', text: '登出', onclick: logout })));

/** 班級切換：兩個班以上才顯示下拉選單；一個班只顯示班名 */
const classBar = () => {
    const list = me?.classes || [];
    if (list.length < 2) return list.length ? h('p', { class: 'stu-classbar stu-sub', id: 'stu-class-name', text: list[0].className }) : null;
    return h('div', { class: 'stu-classbar' },
        h('label', { for: 'stu-class', text: '班級' }),
        h('select', { id: 'stu-class', class: 'stu-select', onchange: (e) => switchClass(e.target.value) },
            list.map(c => h('option', { value: c.id, selected: c.id === current, text: c.className }))));
};

const showMain = async (notice = '') => {
    const tabs = isHelper() ? [...TABS.slice(0, 3), HELPER_TAB, TABS[3]] : TABS;
    if (!tabs.some(([id]) => id === tab)) tab = 'growth';
    const body = h('section', { id: 'stu-body', class: 'stu-body', tabindex: '-1', dataset: { member: current } });
    const nav = h('nav', { class: 'stu-tabs', 'aria-label': '分頁' }, tabs.map(([id, icon, label]) => h('button', {
        type: 'button', class: 'stu-tab', 'aria-current': tab === id ? 'page' : null, dataset: { tab: id },
        onclick: () => { tab = id; showMain(); },
    }, h('span', { class: 'stu-tab-icon', 'aria-hidden': 'true', text: icon }), h('span', { text: label }))));
    screen(header(), classBar(), notice ? msg(notice, 'ok') : null, body, nav);
    fill(body, h('p', { class: 'stu-loading', text: '載入中…' }));
    const my = gen;
    const live = () => my === gen;
    /** 這個畫面的 GET：回來時如果已經換了畫面或班級，就丟掉（不畫到別班的畫面上） */
    const get = async (sub) => { const d = await api('GET', classPath(sub)); if (!live()) throw STALE; return d; };
    try {
        if (tab === 'growth') await renderGrowth(body, get);
        else if (tab === 'homework') await renderHomework(body, get);
        else if (tab === 'zoo') await renderZoo(body, get, live);
        else if (tab === 'helper') await renderHelper(body, get, live);
        else renderHelp(body);
    } catch (e) { if (live()) fail(e); }
};

const notPublished = (body) => fill(body, msg('老師還沒有發布你的資料，請稍後再來看看。', 'info'));

const renderGrowth = async (body, get) => {
    const d = await get('dashboard');
    if (!d.published) return notPublished(body);
    const hs = d.homeworkSummary;
    fill(body,
        h('h2', { text: `${d.me.name}，你好！` }),
        h('p', { class: 'stu-sub', text: d.className }),
        h('div', { class: 'stu-stats' },
            h('div', { class: 'stu-stat' }, h('span', { class: 'stu-stat-num', text: d.me.score.score }), h('span', { text: '可用分數' })),
            h('div', { class: 'stu-stat' }, h('span', { class: 'stu-stat-num', text: d.me.score.earned }), h('span', { text: '累計獲得' }))),
        d.group ? h('div', { class: 'stu-card' },
            h('h3', { text: `🐾 ${d.group.name}` }),
            h('p', { text: `小組 XP：${d.group.xp}　收藏的動物：${d.group.animals} 隻` }),
            h('button', { class: 'stu-btn', type: 'button', text: '去小組園區看看', onclick: () => { tab = 'zoo'; showMain(); } })) : h('div', { class: 'stu-card' }, h('p', { text: '你目前還沒有分到小組。' })),
        h('div', { class: 'stu-card' },
            h('h3', { text: '📚 作業' }),
            h('p', { text: `最近的作業 ${hs.total} 項` }),
            hs.missing ? h('p', { class: 'stu-todo', text: `未繳交：${hs.missing} 項` }) : h('p', { text: '沒有未繳交的作業 👍' }),
            hs.needsCorrection ? h('p', { class: 'stu-todo', text: `未訂正：${hs.needsCorrection} 項` }) : null,
            h('button', { class: 'stu-btn', type: 'button', text: '看作業', onclick: () => { tab = 'homework'; showMain(); } })),
        staleNote(d.publishedAt));
};


const STATE_CLASS = { submitted: 'ok', done: 'ok', missing: 'todo', needs: 'todo', unchecked: 'muted', exempt: 'muted' };
const renderHomework = async (body, get) => {
    const d = await get('homework');
    if (!d.published) return notPublished(body);
    let filter = 'all';
    const list = h('ul', { class: 'stu-hw-list' });
    const draw = () => {
        const items = d.homework.filter(x => filter === 'all' || simpleOf(x.submission, x.correction) === filter);
        fill(list, items.length ? items.map(x => h('li', { class: 'stu-hw' },
            h('div', { class: 'stu-hw-title' }, h('strong', { text: x.title }), h('span', { class: 'stu-hw-type', text: x.type })),
            h('div', { class: 'stu-hw-dates', text: `${x.assignedDate || ''}${x.dueDate ? ` · 期限 ${x.dueDate}` : ''}` }),
            h('div', { class: 'stu-hw-badges' }, (() => { const st = simpleOf(x.submission, x.correction); return h('span', { class: `stu-badge stu-badge-${STATE_CLASS[st] || 'muted'}`, dataset: { state: st }, text: `${simpleLabel(st)}${x.late ? '（補交）' : ''}` }); })()))) : h('li', { class: 'stu-hw-empty', text: '這裡沒有作業。' }));
    };
    const chip = (id, label) => h('button', { type: 'button', class: 'stu-chip', 'aria-pressed': String(filter === id), onclick: (e) => { filter = id; e.currentTarget.parentElement.querySelectorAll('.stu-chip').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw(); } }, label);
    draw();
    fill(body, h('h2', { text: '我的作業' }),
        h('p', { class: 'stu-sub', text: '「未登記」是老師還沒登記，不代表沒交。' }),
        h('div', { class: 'stu-chips', role: 'group', 'aria-label': '篩選' }, chip('all', '全部'), chip('missing', '未繳交'), chip('needs', '未訂正')),
        list, staleNote(d.publishedAt));
};

// ------------------------------------------------------------ 小老師：登記全班作業
const notHelper = async () => { await refreshMe(); tab = 'growth'; route('老師已經取消你的小老師身分。'); };
const renderHelper = async (body, get, live) => {
    let v;
    try { v = await get('helper'); }
    catch (e) { if (e.status === 403 && e.body?.error === 'not_helper') return notHelper(); throw e; }
    if (!v.published || !v.assignments.length) return fill(body, h('h2', { text: '📝 登記作業' }), msg('老師還沒有發布作業。', 'info'));
    let aid = v.assignments[0].assignmentId;
    const note = h('div', { 'aria-live': 'polite' });
    const list = h('ul', { class: 'stu-reg-list' });
    const select = h('select', { id: 'stu-reg-assign', class: 'stu-select', onchange: (e) => { aid = e.target.value; draw(); } },
        v.assignments.map(a => h('option', { value: a.assignmentId, text: `${a.assignedDate || ''} ${a.title}${a.type && a.type !== a.title ? `（${a.type}）` : ''}` })));
    const send = async (sid, state, button) => {
        button.disabled = true;
        const key = newKey(); let r = null;
        for (let i = 0; i < 2 && !r; i++) {                 // 網路斷掉時用同一個 key 重送一次（後端只存一次）
            try { r = await api('POST', classPath('helper/register'), { assignmentId: aid, studentIds: [sid], state, idempotencyKey: key }); }
            catch (e) {
                if (e.status !== 0 || i === 1) {
                    button.disabled = false;
                    if (!live()) return;
                    if (e.status === 401 || e.status === 404 || e.body?.error === 'password_change_required') return fail(e);
                    if (e.body?.error === 'not_helper') return notHelper();
                    return fill(note, msg(e.message, 'error'));
                }
            }
        }
        if (!live()) return;
        Object.assign(v.states[aid] ||= {}, r.states);
        const who = v.students.find(x => x.studentId === sid);
        fill(note, msg(`已登記：${who?.seat ?? ''}號 ${simpleLabel(state)}`, 'ok'));
        draw();
    };
    const draw = () => {
        const st = v.states[aid] || {};
        fill(list, v.students.map(s => {
            const cur = st[s.studentId] || 'unchecked';
            const self = s.studentId === v.selfId;
            return h('li', { class: 'stu-reg', dataset: { sid: s.studentId } },
                h('div', { class: 'stu-reg-who' },
                    h('strong', { text: `${s.seat ?? ''}號` }), s.name && s.name !== `${s.seat ?? ''}號` ? h('span', { text: s.name }) : null,
                    h('span', { class: `stu-badge stu-badge-${STATE_CLASS[cur] || 'muted'}`, text: simpleLabel(cur) })),
                self ? h('p', { class: 'stu-sub', text: '自己的作業請交給老師登記。' })
                    : h('div', { class: 'stu-reg-actions', role: 'group', 'aria-label': `${s.seat ?? ''}號的作業狀態` }, Object.entries(SIMPLE).map(([k, label]) => h('button', {
                        type: 'button', class: `stu-btn stu-reg-btn${cur === k ? ' stu-btn-primary' : ''}`, dataset: { state: k }, 'aria-pressed': String(cur === k),
                        text: `${SIMPLE_ICON[k]} ${label}`, onclick: (e) => send(s.studentId, k, e.currentTarget),
                    }))));
        }));
    };
    draw();
    fill(body,
        h('h2', { text: '📝 登記作業' }),
        h('p', { class: 'stu-sub', text: '幫老師登記同學的作業。按下去就會送給老師；按錯了直接再按正確的就好。' }),
        h('label', { for: 'stu-reg-assign', text: '作業' }), select,
        note, list, staleNote(v.publishedAt));
};

const artItem = (a) => {
    const base = catalogById.get(a.baseItemId);
    return base ? { ...base, id: a.itemId, name: a.name } : { id: a.itemId, name: a.name, rarity: a.rarity, art: { p: 'sprite', c: '#ffd23f', a: '#fff7cc' }, track: 'animal' };
};

const renderZoo = async (body, get, live) => {
    const z = await get('zoo');
    if (!z.published) return notPublished(body);
    if (!z.group) return fill(body, msg('你目前還沒有分到小組，分組後就能一起照顧動物。', 'info'));
    const g = z.group;
    const world = g.worldId || g.animals.map(a => catalogById.get(a.baseItemId)?.world).find(Boolean) || 'land';
    const { svg, layer } = sceneSVG(world, { decorLevel: 0, label: `${g.name}的園區` });
    svg.setAttribute('role', 'group');     // 裡面有可以按的動物：不能標成 img（螢幕閱讀器會把按鈕藏起來）
    let selected = null;
    const panel = h('div', { id: 'stu-care-panel', class: 'stu-care-panel', 'aria-live': 'polite' });
    const remaining = () => Math.max(0, z.myToday.limit - z.myToday.used);
    const drawPanel = (note = null) => {
        if (!selected) { fill(panel, h('p', { text: g.animals.length ? '點一隻動物來照顧牠。' : '你們小組還沒有動物。多多加油，老師會幫小組解鎖新夥伴！' }), note); return; }
        const a = selected.animal; const c = z.care.animals[a.itemId] || { care: 0, mood: 'calm' };
        const mood = MOODS[c.mood] || MOODS.calm;
        fill(panel,
            h('h3', { text: `${a.name}` }),
            h('p', { text: `${rarityById.get(a.rarity)?.name || ''} · 心情：${mood.icon} ${mood.label} · 小組照顧了 ${c.care} 次` }),
            h('div', { class: 'stu-care-actions' }, Object.entries(CARE_ACTIONS).map(([act, label]) => h('button', {
                type: 'button', class: 'stu-btn stu-btn-primary', dataset: { action: act }, text: act === 'feed' ? `🍎 ${label}` : `🤝 ${label}`,
                onclick: (e) => doCare(a, act, e.currentTarget),
            }))),
            h('p', { class: 'stu-sub', text: remaining() ? `今天你還可以照顧 ${remaining()} 次。` : '今天的照顧次數用完了，明天再來！（還是可以跟牠玩）' }),
            note);
    };
    const doCare = async (a, action, button) => {
        button.disabled = true;
        const key = newKey();
        let r = null;
        for (let i = 0; i < 2 && !r; i++) {                 // 網路斷掉時用同一個 key 重送一次（後端只算一次）
            try { r = await api('POST', classPath('care'), { itemId: a.itemId, action, idempotencyKey: key }); }
            catch (e) { if (e.status !== 0 || i === 1) { button.disabled = false; if (!live()) return; if (e.status === 401 || e.status === 403 || e.status === 404) return fail(e); return drawPanel(msg(e.message, 'error')); } }
        }
        if (!live()) return;
        z.myToday = r.myToday; z.care = r.care;
        selected.node.classList.remove('react'); void selected.node.getBBox?.(); if (!reducedMotion()) selected.node.classList.add('react');
        drawCareInfo();
        drawPanel(msg(r.counted ? `${a.name}${action === 'feed' ? '吃得好開心' : '很喜歡你陪牠'}！小組照顧 +1` : `${a.name}很開心見到你！（今天的照顧次數已用完，這次不計入）`, r.counted ? 'ok' : 'info'));
    };
    g.animals.forEach((a, i) => {
        const node = placeInScene(layer, sceneCreature(artItem(a), { stage: a.stage, artId: a.baseItemId }), i, {
            title: `${a.name}（心情：${MOODS[z.care.animals[a.itemId]?.mood || 'calm'].label}）`,
            onClick: (n) => { selected = { animal: a, node: n }; layer.querySelectorAll('.scene-actor').forEach(x => x.classList.toggle('selected', x === n)); drawPanel(); },
        });
        node.dataset.item = a.itemId;
    });
    const info = h('div', { class: 'stu-card stu-care-info' });
    const drawCareInfo = () => {
        const c = z.care;
        fill(info,
            h('p', {}, `🤝 小組累計照顧 ${c.total} 次 · ⭐ 團隊星 ${c.teamStars} 顆`),
            h('p', { text: `今天小組有 ${c.today.participants} 位同學照顧過（${c.today.needed} 位就能得到團隊星）` }),
            h('p', { class: 'stu-badges' }, z.badges.map(b => h('span', { class: `stu-deco${c.badges.includes(b.id) ? ' on' : ''}`, title: c.badges.includes(b.id) ? b.name : `累計 ${b.at} 次解鎖：${b.name}`, text: c.badges.includes(b.id) ? b.icon : '🔒' }))),
            c.nextBadge ? h('p', { class: 'stu-sub', text: `再照顧 ${c.nextBadge.at - c.total} 次，園區會出現「${c.nextBadge.name}」。` }) : h('p', { class: 'stu-sub', text: '所有裝飾都解鎖了，太厲害了！' }));
    };
    drawCareInfo(); drawPanel();
    const decoRow = h('div', { class: 'stu-scene-deco', 'aria-hidden': 'true' }, z.care.badges.map(id => CARE_BADGES.find(b => b.id === id)?.icon || ''));
    fill(body,
        h('h2', { text: `${g.name}的園區` }),
        h('p', { class: 'stu-sub', text: `${worldById.get(world)?.name || ''} · 小組 XP ${g.xp}（動物的成長由小組 XP 決定）` }),
        h('div', { class: 'stu-scene' }, svg, decoRow),
        panel, info, staleNote(z.publishedAt));
};

const renderHelp = (body) => fill(body,
    h('h2', { text: '說明' }),
    h('div', { class: 'stu-card' },
        h('h3', { text: '🐾 怎麼照顧動物？' }),
        h('ul', {},
            h('li', { text: '在「小組園區」點一隻動物，可以餵食或陪伴。' }),
            h('li', { text: '每個人每天最多 3 次照顧會被記錄，用完後還是可以跟動物玩，但不會再計入。' }),
            h('li', { text: '照顧會讓動物心情變好，小組累計照顧次數會解鎖園區裝飾。' }),
            h('li', { text: '有一半以上的組員在同一天照顧過，小組就會得到一顆團隊星。大家一起來比一個人一直按更重要！' }),
            h('li', { text: '動物不會生病，也不會離開。沒有登入的日子也沒關係。' }),
            h('li', { text: '照顧不會改變分數或 XP。動物長大是靠小組在課堂上的表現（XP）。' }))),
    h('div', { class: 'stu-card' },
        h('h3', { text: '🔐 帳號安全' }),
        h('ul', {},
            h('li', { text: '不要把密碼告訴別人。忘記密碼請找老師；連結過 Google 的同學也可以用 Google 自己設新密碼。' }),
            h('li', { text: '每個班級的分數、作業和小組都是分開的，別班的老師和同學看不到。' }),
            h('li', { text: '用共用的電腦或平板時，用完一定要按右上角「登出」。' }),
            h('li', { text: '你只看得到自己的分數和作業，別人也看不到你的。' }))));

// ------------------------------------------------------------ 我的班級：切換、退出、輸入代碼加入（P3）
const showClasses = (notice = '') => {
    const list = me?.classes || [];
    const out = h('div', { id: 'stu-join-msg', 'aria-live': 'polite' });
    const code = h('input', { id: 'stu-code', name: 'code', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', inputmode: 'latin', required: true, maxlength: 32, value: joinCode || null });
    const name = h('input', { id: 'stu-join-name', name: 'nickname', autocomplete: 'off', maxlength: 20 });
    const seat = h('input', { id: 'stu-join-seat', name: 'seat', type: 'number', inputmode: 'numeric', min: 1, max: 99 });
    joinCode = '';                                          // 用過就清掉（只填一次）
    const btn = h('button', { class: 'stu-btn stu-btn-primary', type: 'submit', text: '送出代碼' });
    const form = h('form', { class: 'stu-card stu-login', id: 'stu-join', onsubmit: async (e) => {
        e.preventDefault(); btn.disabled = true; fill(out, msg('處理中…'));
        const body = { code: code.value.trim(), ...(name.value.trim() ? { displayName: name.value.trim() } : {}), ...(seat.value ? { seatHint: Number(seat.value) } : {}) };
        try {
            const r = await api('POST', '/api/student/redeem', body);
            await refreshMe();
            if (r.kind === 'claim') { current = r.id; tab = 'growth'; return showMain(`已經加入「${r.className}」！`); }
            return showClasses(`已經送出申請到「${r.className}」，等老師確認後就會出現在這裡。`);
        } catch (err) {
            btn.disabled = false;
            if (err.status === 401) return fail(err);
            fill(out, msg(err.message, 'error'));
            if (err.body?.error === 'need_name') name.focus();
        }
    } },
    h('h3', { text: '➕ 加入班級' }),
    h('p', { class: 'stu-sub', text: '輸入老師給你的代碼（班級邀請碼或你的個人綁定碼）。用班級邀請碼時，請寫上你的名字，老師確認後才會加入。' }),
    h('label', { for: 'stu-code', text: '代碼' }), code,
    h('label', { for: 'stu-join-name', text: '你的名字（用邀請碼時要填）' }), name,
    h('label', { for: 'stu-join-seat', text: '座號（知道的話）' }), seat,
    out, btn);
    const leave = (c) => {
        const row = document.querySelector(`[data-member="${CSS.escape(c.id)}"] .stu-class-actions`);
        fill(row, h('span', { class: 'stu-sub', text: `確定要退出「${c.className}」嗎？之後要老師重新核准才能回來。` }),
            h('button', { class: 'stu-btn', type: 'button', dataset: { confirm: 'leave' }, text: '確定退出', onclick: async (e) => {
                e.currentTarget.disabled = true;
                try { await api('POST', `/api/student/classes/${encodeURIComponent(c.id)}/leave`, {}); }
                catch (err) { if (err.status === 401) return fail(err); }
                await refreshMe(); if (current === c.id) current = null;
                showClasses(`已經退出「${c.className}」。`);
            } }),
            h('button', { class: 'stu-btn', type: 'button', text: '取消', onclick: () => showClasses() }));
    };
    screen(header(), notice ? msg(notice, 'ok') : null,
        h('h2', { text: '我的班級' }),
        list.length ? h('ul', { class: 'stu-class-list' }, list.map(c => h('li', { class: 'stu-class', dataset: { member: c.id } },
            h('div', {}, h('strong', { text: c.className }), c.id === current ? h('span', { class: 'stu-badge stu-badge-ok', text: '目前' }) : null, c.helper ? h('span', { class: 'stu-badge stu-badge-muted', text: '小老師' }) : null),
            h('div', { class: 'stu-class-actions' },
                h('button', { class: 'stu-btn stu-btn-primary', type: 'button', dataset: { action: 'open' }, text: '進入', onclick: () => { current = c.id; if (tab === 'helper' && !c.helper) tab = 'growth'; showMain(); } }),
                h('button', { class: 'stu-btn', type: 'button', dataset: { action: 'leave' }, text: '退出', onclick: () => leave(c) })))))
            : msg('你還沒有加入任何班級。輸入老師給的代碼就可以加入。', 'info'),
        me?.pending?.length ? h('div', { class: 'stu-card', id: 'stu-pending' },
            h('h3', { text: '⏳ 等老師確認' }),
            h('ul', {}, me.pending.map(p => h('li', { text: `${p.className}（${fmtTime(p.since)} 送出）` })))) : null,
        form);
    if (code.value) name.focus(); else code.focus();
};

// ------------------------------------------------------------ 帳號：改密碼、連結／解除 Google、用 Google 設新密碼（P3）
const showAccount = (notice = '') => {
    const out = h('div', { id: 'stu-account-msg', 'aria-live': 'polite' });
    const say = (text, kind) => fill(out, msg(text, kind));
    const parts = [header(), notice ? msg(notice, 'ok') : null, h('h2', { text: '帳號' })];
    parts.push(h('div', { class: 'stu-card' },
        h('p', { text: me?.username ? `帳號：${me.username}` : '這個帳號是用 Google 建立的（沒有帳號密碼）。' }),
        me?.hasPassword ? h('button', { class: 'stu-btn', type: 'button', id: 'stu-change-pw', text: '改密碼', onclick: () => showChangePassword(false) }) : null));
    if (gcfg) {
        const slot = h('div', { class: 'stu-gsi', id: 'stu-gsi' });
        const pw = h('input', { id: 'stu-acct-pw', type: 'password', autocomplete: 'current-password', maxlength: 128 });
        if (!me?.google) {
            parts.push(h('div', { class: 'stu-card stu-login', id: 'stu-link' },
                h('h3', { text: '🔗 連結 Google 帳號' }),
                h('p', { class: 'stu-sub', text: '連結後可以用 Google 登入，忘記密碼時也能自己設新密碼。請先輸入目前的密碼，再按 Google 按鈕。' }),
                h('label', { for: 'stu-acct-pw', text: '目前的密碼' }), pw, slot));
            googleButton(slot, gcfg.clientId, async (g) => {
                if (!pw.value) { say('請先輸入目前的密碼。', 'error'); pw.focus(); return; }
                try { await api('POST', '/api/student/identities/google', { ...g, currentPassword: pw.value }); pw.value = ''; await refreshMe(); showAccount('已經連結 Google。'); }
                catch (e) { pw.value = ''; if (e.status === 401) return fail(e); say(e.message, 'error'); }
            }, { text: 'continue_with' }).catch(() => fill(slot, msg('Google 登入現在不能用。', 'warn')));
        } else {
            parts.push(h('div', { class: 'stu-card' }, h('p', { text: '✅ 已經連結 Google，可以用 Google 登入。' })));
            if (me.hasPassword) {
                const n1 = h('input', { id: 'stu-g-new', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 64 });
                const n2 = h('input', { id: 'stu-g-new2', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 64 });
                parts.push(h('div', { class: 'stu-card stu-login', id: 'stu-g-reset' },
                    h('h3', { text: '🔐 忘記密碼？用 Google 設新密碼' }),
                    h('label', { for: 'stu-g-new', text: '新密碼' }), n1,
                    h('label', { for: 'stu-g-new2', text: '再輸入一次新密碼' }), n2,
                    h('p', { class: 'stu-sub', text: '輸入新密碼後按 Google 按鈕，再確認一次是你本人。其他裝置會全部登出。' }), slot));
                googleButton(slot, gcfg.clientId, async (g) => {
                    if (!n1.value || n1.value !== n2.value) { say('兩次輸入的新密碼不一樣。', 'error'); return; }
                    try { const r = await api('POST', '/api/student/password/google-reset', { ...g, newPassword: n1.value }); csrf = r.csrf; n1.value = n2.value = ''; await refreshMe(); showAccount('新密碼設定好了！其他裝置都已經登出。'); }
                    catch (e) { if (e.status === 401) return fail(e); say(e.message, 'error'); }
                }, { text: 'continue_with' }).catch(() => fill(slot, msg('Google 登入現在不能用。', 'warn')));
                parts.push(h('form', { class: 'stu-card stu-login', id: 'stu-unlink', onsubmit: async (e) => {
                    e.preventDefault();
                    try { await api('POST', '/api/student/identities/google/unlink', { currentPassword: pw.value }); pw.value = ''; await refreshMe(); showAccount('已經解除 Google 連結。'); }
                    catch (err) { pw.value = ''; if (err.status === 401) return fail(err); say(err.message, 'error'); }
                } }, h('h3', { text: '解除 Google 連結' }), h('label', { for: 'stu-acct-pw', text: '目前的密碼' }), pw,
                h('button', { class: 'stu-btn', type: 'submit', text: '解除連結' })));
            }
        }
    }
    parts.push(out, h('button', { class: 'stu-btn', type: 'button', text: '返回', onclick: () => route() }));
    screen(...parts);
};

// ------------------------------------------------------------ 啟動
/** QR 連結 student.html#join=代碼：讀進記憶體後立刻從網址列清掉（不留在瀏覽紀錄、書籤、分享出去的網址） */
const takeJoinCode = () => {
    const m = /^#join=([A-Za-z0-9-]{1,32})$/.exec(location.hash || '');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return m ? m[1] : '';
};
const boot = async () => {
    joinCode = takeJoinCode() || joinCode;
    try { gcfg = (await api('GET', '/api/student/config')).google || null; } catch { gcfg = null; }
    try {
        me = await api('GET', '/api/student/me'); csrf = me.csrf;
        route();
    } catch (e) { if (e.status === 401) showLogin(); else fail(e); }
};
boot();
