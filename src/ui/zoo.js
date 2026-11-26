// 2.5D 立體園區：分層景深、角色自主行為、放大／平移／全螢幕、點選互動。
// 模擬邏輯在 src/core/zoo-sim.js（純函式）；這裡只負責 DOM 與動畫迴圈。
import { h, fill } from './dom.js';
import { sceneSVG } from '../art/scenes.js';
import { zooProps, MILESTONE_LAYOUT } from '../art/zoo-props.js';
import { ambientLayers } from '../art/ambient.js';
import { BACKDROPS, PROPS } from '../data/art-manifest.js';
import { DEFAULT_CLASS_MILESTONES } from '../core/xp.js';
import { creatureSVG } from '../art/creatures.js';
import { artUrl, stageScale } from '../art/sprites.js';
import { initActor, stepActor, startBehavior, projectActor, groundY } from '../core/zoo-sim.js';

const FOOD = { land: '🍎', ocean: '🦐', sky: '🌾', tech: '🔋', prehistoric: '🌿', fantasy: '✨' };
const BUBBLE = { sleep: '💤', look: '👀', play: '🎵', greet: '💬', pet: '❤️' };
const ZOOM_MIN = 1, ZOOM_MAX = 2.6;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const sprite = (item, stage, artId) => {
    const id = artId || item.id;
    const url = artUrl(id, stage);
    if (url) return h('img', { class: 'zoo-sprite', src: url, alt: '', draggable: 'false', decoding: 'async' });
    const svg = creatureSVG(item, { size: 120, stage: 2 });   // 佔位圖：成長由外層縮放表現，不加完成星章
    svg.classList.add('zoo-sprite');
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('aria-hidden', 'true');
    return svg;
};

/**
 * opts：{ world, actors: [{ item, stage, title, stageLabel, artId }], decorLevel, label, reducedMotion(), onDetail(itemId), onInteract(kind) }
 * 回傳 { el, destroy }
 */
export const createZoo = (opts) => {
    const { world, decorLevel = 0, label = '' } = opts;
    const reduced = () => !!opts.reducedMotion?.();
    // 背景：有核准的 AI 背景板就用圖片（里程碑改成道具擺進場景），否則用原本的 SVG 場景（里程碑畫在背景裡）
    const aiBack = BACKDROPS.includes(world);
    const back = h('div', { class: 'zoo-back' + (aiBack ? ' ai' : '') },
        aiBack ? h('img', { src: `assets/creatures/bg-${world}.webp`, alt: label, decoding: 'async', draggable: 'false' }) : sceneSVG(world, { decorLevel, label }).svg);
    const amb = ambientLayers(world);
    const stageEl = h('div', { class: 'zoo-stage' });
    const cam = h('div', { class: 'zoo-cam' }, back, amb.back, stageEl, amb.front);
    const view = h('div', { class: 'zoo-view' }, cam);
    const panel = h('div', { class: 'zoo-panel', hidden: true, role: 'group', 'aria-label': '夥伴互動' });
    const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const btn = (text, title, onclick, cls = '') => h('button', { class: 'zoo-btn ' + cls, type: 'button', title, 'aria-label': title, text, onclick });
    const hud = h('div', { class: 'zoo-hud' },
        btn('＋', '放大', () => zoomBy(1.35)), btn('－', '縮小', () => zoomBy(1 / 1.35)), btn('⟲', '回到全景', () => resetCam()),
        btn('⛶', '全螢幕', () => toggleFull(), 'zoo-full-btn'));
    const root = h('div', { class: `zoo zoo-${world}`, dataset: { world } }, view, hud, panel, live);

    // ------------------------------------------------------------ 道具
    const placeProp = (cls, x, z, hh, node, ratio = 1) => stageEl.append(h('div', { class: `zoo-prop ${cls}`,
        style: `left:${x * 100}%;top:${groundY(world, z) * 100}%;height:${hh * (0.55 + 0.45 * z) * 100}%;aspect-ratio:${ratio};z-index:${Math.round(z * 1000)};--dim:${(0.8 + 0.2 * z).toFixed(2)}` }, node));
    const propImg = (id) => h('img', { src: `assets/creatures/${id}.webp`, alt: '', decoding: 'async', draggable: 'false' });
    for (const p of zooProps(world, (id) => id in PROPS)) {
        placeProp(`zoo-prop-${p.kind}`, p.x, p.z, p.h, p.art ? propImg(p.art) : p.svg, p.art ? PROPS[p.art] : 1);
    }
    if (aiBack) {     // 全班里程碑：有 AI 道具圖就擺圖，否則先用告示牌（圖示＋名稱）
        MILESTONE_LAYOUT.slice(0, decorLevel).forEach(([id, x, z, hh], i) => {
            const m = DEFAULT_CLASS_MILESTONES[i];
            if (id in PROPS) placeProp('zoo-milestone', x, z, hh, propImg(id), PROPS[id]);
            else placeProp('zoo-milestone zoo-ms-sign', x, z, 0.12, h('span', { title: m.name }, h('b', { text: m.icon }), h('small', { text: m.name })));
        });
    }

    // ------------------------------------------------------------ 角色
    const list = opts.actors.map((a, i) => {
        const sim = initActor(a.item, i, opts.actors.length);
        const grow = stageScale(a.artId || a.item.id, a.stage);
        const fx = [];
        if (a.item.rarity === 'legendary') fx.push(h('span', { class: 'zoo-fx fx-aura', 'aria-hidden': 'true' }));
        if (a.item.rarity === 'epic') fx.push(h('span', { class: 'zoo-fx fx-sparkle', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(k => h('i', { style: `--k:${k}` }))));
        const flip = h('div', { class: 'zoo-flip' }, sprite(a.item, a.stage, a.artId));
        const bubble = h('span', { class: 'zoo-bubble', 'aria-hidden': 'true' });
        const node = h('button', { class: `zoo-actor mode-${sim.mode} r-${a.item.rarity}${a.stage >= 3 ? ' complete' : ''}`, type: 'button', dataset: { item: a.item.id, state: 'idle' },
            'aria-label': a.title, title: a.title, onclick: (e) => { e.stopPropagation(); select(entry); } },
            h('span', { class: 'zoo-shadow', 'aria-hidden': 'true' }), a.stage >= 3 ? h('span', { class: 'zoo-ring', 'aria-hidden': 'true' }) : null,
            h('div', { class: 'actor-bob' }, ...fx, flip), bubble);
        stageEl.append(node);
        const entry = { a, sim, node, flip, bubble, grow, lastState: null, lastBubble: null };
        return entry;
    });
    const sims = list.map(e => e.sim);

    const paint = (e) => {
        const p = projectActor(e.sim, world);
        const st = e.node.style;
        st.left = `${p.x * 100}%`; st.top = `${p.y * 100}%`; st.height = `${p.h * e.grow * 100}%`; st.zIndex = String(p.zIndex);
        st.setProperty('--dim', String(0.78 + 0.22 * e.sim.z));
        e.flip.style.transform = e.sim.face > 0 ? 'scaleX(-1)' : '';
        const state = e.sim.state === 'wander' ? 'walk' : e.sim.state;
        if (state !== e.lastState) { e.node.dataset.state = state; e.lastState = state; }
        const b = state === 'eat' || state === 'feed' ? FOOD[world] : state === 'greet' ? (e.sim.partner && e.sim.id < e.sim.partner.id ? '💬' : '❤️') : BUBBLE[state] || '';
        if (b !== e.lastBubble) { e.bubble.textContent = b; e.bubble.classList.toggle('on', !!b); e.lastBubble = b; }
        return p;
    };

    // ------------------------------------------------------------ 鏡頭
    const camState = { zoom: 1, cx: 0.5, cy: 0.5 };
    let selected = null;
    const applyCam = () => {
        const W = view.clientWidth, H = view.clientHeight;
        const z = camState.zoom;
        const tx = clamp(W / 2 - camState.cx * W * z, W - W * z, 0);
        const ty = clamp(H / 2 - camState.cy * H * z, H - H * z, 0);
        cam.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
        root.classList.toggle('zoomed', z > 1.01);
    };
    const zoomBy = (k) => { camState.zoom = clamp(camState.zoom * k, ZOOM_MIN, ZOOM_MAX); applyCam(); };
    const resetCam = () => { select(null); camState.zoom = 1; camState.cx = 0.5; camState.cy = 0.5; applyCam(); };
    const toggleFull = () => {
        const pseudo = () => { root.classList.toggle('pseudo-full'); requestAnimationFrame(applyCam); };
        if (document.fullscreenElement === root) document.exitFullscreen?.();
        else if (root.classList.contains('pseudo-full') || !root.requestFullscreen) pseudo();   // 不支援全螢幕 API（例如 iPhone Safari）時，改用填滿視窗
        else root.requestFullscreen().catch(pseudo);
    };
    const onFull = () => { root.classList.toggle('is-full', document.fullscreenElement === root); requestAnimationFrame(applyCam); };
    document.addEventListener('fullscreenchange', onFull);

    // 拖曳平移（放大時）與雙擊放大
    let drag = null;
    view.addEventListener('pointerdown', (e) => {
        if (camState.zoom <= 1.01 || e.target.closest('.zoo-actor')) return;
        drag = { x: e.clientX, y: e.clientY, cx: camState.cx, cy: camState.cy };
        view.setPointerCapture?.(e.pointerId);
    });
    view.addEventListener('pointermove', (e) => {
        if (drag) {
            const W = view.clientWidth, H = view.clientHeight;
            camState.cx = clamp(drag.cx - (e.clientX - drag.x) / (W * camState.zoom), 0, 1);
            camState.cy = clamp(drag.cy - (e.clientY - drag.y) / (H * camState.zoom), 0, 1);
            if (selected) select(null);
            applyCam();
            return;
        }
        if (reduced()) return;
        const r = view.getBoundingClientRect();     // 視差：滑鼠位置讓背景輕微反向移動
        const ox = (e.clientX - r.left) / r.width - 0.5, oy = (e.clientY - r.top) / r.height - 0.5;
        back.style.transform = `translate(${-ox * 14}px, ${-oy * 6}px) scale(1.04)`;
    });
    const endDrag = () => { drag = null; };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    view.addEventListener('pointerleave', () => { if (!drag) back.style.transform = ''; });
    view.addEventListener('dblclick', (e) => {
        if (e.target.closest('.zoo-actor')) return;
        const r = cam.getBoundingClientRect();
        camState.cx = (e.clientX - r.left) / r.width; camState.cy = (e.clientY - r.top) / r.height;
        zoomBy(1.6);
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected) { e.stopPropagation(); select(null); } });

    // ------------------------------------------------------------ 選取與互動
    const act = (kind) => {
        if (!selected) return;
        startBehavior(selected.sim, kind);
        selected.node.classList.remove('pop'); void selected.node.offsetWidth; selected.node.classList.add('pop');
        if (reduced()) paint(selected);
        opts.onInteract?.(kind);
        live.textContent = kind === 'feed' ? `${selected.a.item.name}吃得很開心` : `${selected.a.item.name}很開心`;
    };
    const select = (entry) => {
        list.forEach(e => e.node.classList.toggle('selected', e === entry));
        selected = entry;
        if (!entry) { panel.hidden = true; return; }
        panel.hidden = false;
        fill(panel,
            h('div', { class: 'zoo-panel-t' }, h('strong', { text: entry.a.item.name }), h('small', { text: entry.a.stageLabel || '' })),
            h('div', { class: 'zoo-panel-b' },
                btn(`${FOOD[world]} 餵食`, '餵食', () => act('feed')), btn('👋 拍拍', '拍拍', () => act('pet')),
                opts.onDetail ? btn('📖 詳情', '查看詳情', () => opts.onDetail(entry.a.item.id)) : null,
                btn('✕', '取消選取', () => select(null), 'zoo-close')));
        if (camState.zoom < 1.8) camState.zoom = 1.8;
        const p = projectActor(entry.sim, world);
        camState.cx = p.x; camState.cy = p.y - p.h * 0.5;
        applyCam();
    };

    // ------------------------------------------------------------ 動畫迴圈
    let raf = 0, last = 0, alive = true;
    const frame = (t) => {
        if (!alive) return;
        if (!root.isConnected && last) { destroy(); return; }
        const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
        last = t;
        if (!document.hidden && !reduced()) {
            for (const e of list) stepActor(e.sim, dt, sims);
            for (const e of list) paint(e);
            if (selected) {        // 鏡頭平滑跟隨選取的角色
                const p = projectActor(selected.sim, world);
                camState.cx += (p.x - camState.cx) * Math.min(1, dt * 3);
                camState.cy += (p.y - p.h * 0.5 - camState.cy) * Math.min(1, dt * 3);
                applyCam();
            }
        }
        raf = requestAnimationFrame(frame);
    };
    const destroy = () => { alive = false; cancelAnimationFrame(raf); document.removeEventListener('fullscreenchange', onFull); };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyCam()) : null;
    ro?.observe(view);

    list.forEach(paint);
    raf = requestAnimationFrame(frame);
    return { el: root, destroy: () => { destroy(); ro?.disconnect(); } };
};
