// v6.2 學生學習中心（student.html）。手機優先；與學生系統 API 同源。
// 安全：不在瀏覽器存任何資料（只有 HttpOnly Cookie）；CSRF token 只放記憶體；DOM 一律 textContent（不用 HTML 字串）。
// 學生只能看到自己的分數與作業、所屬小組的園區；照顧結果由後端裁決，前端不計算任何 XP／分數／成長。
import { h, fill } from '../ui/dom.js';
import { SUBMISSION, CORRECTION } from '../core/homework.js';
import { CARE_ACTIONS, MOODS, CARE_BADGES } from '../core/care.js';
import { catalogById, worldById, rarityById } from '../data/catalog.js';
import { creatureSVG } from '../art/creatures.js';
import { sceneSVG, placeInScene } from '../art/scenes.js';

const root = document.getElementById('app');
const STALE_DAYS = 3;
let csrf = null;
let tab = 'growth';
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
const fail = (e) => {
    if (e.status === 401) { csrf = null; showLogin('登入已經過期，請重新登入。'); return; }
    if (e.status === 403 && e.body?.error === 'password_change_required') { showChangePassword(); return; }
    fill(root, msg(e.message || '發生錯誤', 'error'), h('button', { class: 'stu-btn', type: 'button', text: '重新整理', onclick: () => boot() }));
};

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
            if (r.mustChangePassword) showChangePassword(true); else showMain();
        } catch (err) { fill(out, msg(err.message, 'error')); btn.disabled = false; pass.value = ''; pass.focus(); }
    } },
    h('h1', { text: '🌟 學生學習中心' }),
    h('label', { for: 'stu-user', text: '帳號' }), user,
    h('label', { for: 'stu-pass', text: '密碼' }), pass,
    out, btn,
    h('p', { class: 'stu-hint', text: '帳號和第一次的密碼由老師發給你。忘記密碼請找老師重設。用學校或家裡共用的電腦時，用完記得按「登出」。' }));
    fill(root, form);
    user.focus();
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
            csrf = r.csrf; showMain('密碼改好了！以後請用新密碼登入。');
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
    first ? h('button', { class: 'stu-btn', type: 'button', text: '登出', onclick: logout }) : h('button', { class: 'stu-btn', type: 'button', text: '取消', onclick: () => showMain() }));
    fill(root, form);
    cur.focus();
};

const logout = async () => {
    try { await api('POST', '/api/student/logout', {}); } catch { /* 已失效也一樣回到登入畫面 */ }
    csrf = null; showLogin('已經登出。');
};

// ------------------------------------------------------------ 主畫面
const TABS = [['growth', '🌱', '我的成長'], ['homework', '📚', '我的作業'], ['zoo', '🐾', '小組園區'], ['help', '❓', '說明']];

const showMain = async (notice = '') => {
    const body = h('section', { id: 'stu-body', class: 'stu-body', tabindex: '-1' });
    const nav = h('nav', { class: 'stu-tabs', 'aria-label': '分頁' }, TABS.map(([id, icon, label]) => h('button', {
        type: 'button', class: 'stu-tab', 'aria-current': tab === id ? 'page' : null, dataset: { tab: id },
        onclick: () => { tab = id; showMain(); },
    }, h('span', { class: 'stu-tab-icon', 'aria-hidden': 'true', text: icon }), h('span', { text: label }))));
    const header = h('header', { class: 'stu-header' },
        h('strong', { text: '🌟 學生學習中心' }),
        h('span', { class: 'stu-header-actions' },
            h('button', { class: 'stu-link', type: 'button', text: '改密碼', onclick: () => showChangePassword(false) }),
            h('button', { id: 'stu-logout', class: 'stu-link', type: 'button', text: '登出', onclick: logout })));
    fill(root, header, notice ? msg(notice, 'ok') : null, body, nav);
    fill(body, h('p', { class: 'stu-loading', text: '載入中…' }));
    try {
        if (tab === 'growth') await renderGrowth(body);
        else if (tab === 'homework') await renderHomework(body);
        else if (tab === 'zoo') await renderZoo(body);
        else renderHelp(body);
    } catch (e) { fail(e); }
};

const notPublished = (body) => fill(body, msg('老師還沒有發布你的資料，請稍後再來看看。', 'info'));

const renderGrowth = async (body) => {
    const d = await api('GET', '/api/student/dashboard');
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
            hs.missing ? h('p', { class: 'stu-todo', text: `還沒交：${hs.missing} 項` }) : h('p', { text: '沒有未交的作業 👍' }),
            hs.needsCorrection ? h('p', { class: 'stu-todo', text: `要訂正：${hs.needsCorrection} 項` }) : null,
            h('button', { class: 'stu-btn', type: 'button', text: '看作業', onclick: () => { tab = 'homework'; showMain(); } })),
        staleNote(d.publishedAt));
};

const SUB_CLASS = { unchecked: 'muted', missing: 'todo', submitted: 'ok', exempt: 'muted' };
const COR_CLASS = { ungraded: 'muted', needs: 'todo', done: 'ok', none: 'muted' };

const renderHomework = async (body) => {
    const d = await api('GET', '/api/student/homework');
    if (!d.published) return notPublished(body);
    let filter = 'all';
    const list = h('ul', { class: 'stu-hw-list' });
    const draw = () => {
        const items = d.homework.filter(x => filter === 'all' || (filter === 'missing' ? x.submission === 'missing' : x.correction === 'needs'));
        fill(list, items.length ? items.map(x => h('li', { class: 'stu-hw' },
            h('div', { class: 'stu-hw-title' }, h('strong', { text: x.title }), h('span', { class: 'stu-hw-type', text: x.type })),
            h('div', { class: 'stu-hw-dates', text: `${x.assignedDate || ''}${x.dueDate ? ` · 期限 ${x.dueDate}` : ''}` }),
            h('div', { class: 'stu-hw-badges' },
                h('span', { class: `stu-badge stu-badge-${SUB_CLASS[x.submission]}`, text: `繳交：${SUBMISSION[x.submission]}${x.late ? '（補交）' : ''}` }),
                x.correction ? h('span', { class: `stu-badge stu-badge-${COR_CLASS[x.correction]}`, text: `訂正：${CORRECTION[x.correction]}` }) : null))) : h('li', { class: 'stu-hw-empty', text: '這裡沒有作業。' }));
    };
    const chip = (id, label) => h('button', { type: 'button', class: 'stu-chip', 'aria-pressed': String(filter === id), onclick: (e) => { filter = id; e.currentTarget.parentElement.querySelectorAll('.stu-chip').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw(); } }, label);
    draw();
    fill(body, h('h2', { text: '我的作業' }),
        h('p', { class: 'stu-sub', text: '「未登記」是老師還沒登記，不代表沒交；「已交」之後還要看「訂正」。' }),
        h('div', { class: 'stu-chips', role: 'group', 'aria-label': '篩選' }, chip('all', '全部'), chip('missing', '未交'), chip('needs', '待訂正')),
        list, staleNote(d.publishedAt));
};

const artItem = (a) => {
    const base = catalogById.get(a.baseItemId);
    return base ? { ...base, id: a.itemId, name: a.name } : { id: a.itemId, name: a.name, rarity: a.rarity, art: { p: 'sprite', c: '#ffd23f', a: '#fff7cc' }, track: 'animal' };
};

const renderZoo = async (body) => {
    const z = await api('GET', '/api/student/zoo');
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
            try { r = await api('POST', '/api/student/care', { itemId: a.itemId, action, idempotencyKey: key }); }
            catch (e) { if (e.status !== 0 || i === 1) { button.disabled = false; if (e.status === 401 || e.status === 403) return fail(e); return drawPanel(msg(e.message, 'error')); } }
        }
        z.myToday = r.myToday; z.care = r.care;
        selected.node.classList.remove('react'); void selected.node.getBBox?.(); if (!reducedMotion()) selected.node.classList.add('react');
        drawCareInfo();
        drawPanel(msg(r.counted ? `${a.name}${action === 'feed' ? '吃得好開心' : '很喜歡你陪牠'}！小組照顧 +1` : `${a.name}很開心見到你！（今天的照顧次數已用完，這次不計入）`, r.counted ? 'ok' : 'info'));
    };
    g.animals.forEach((a, i) => {
        const node = placeInScene(layer, creatureSVG(artItem(a), { stage: a.stage }), i, {
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
            h('li', { text: '不要把密碼告訴別人。忘記密碼請找老師重設。' }),
            h('li', { text: '用共用的電腦或平板時，用完一定要按右上角「登出」。' }),
            h('li', { text: '你只看得到自己的分數和作業，別人也看不到你的。' }))));

// ------------------------------------------------------------ 啟動
const boot = async () => {
    try {
        const me = await api('GET', '/api/student/me');
        csrf = me.csrf;
        if (me.mustChangePassword) showChangePassword(true); else showMain();
    } catch (e) { if (e.status === 401) showLogin(); else fail(e); }
};
boot();
