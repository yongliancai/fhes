// DOM 小工具。所有文字一律以 textNode / textContent 寫入（禁止 innerHTML，見 guardrails）。
export const $ = (id) => document.getElementById(id);

/** 元素建構器：h('div', { class, text, dataset, style, onclick, ...attrs }, ...children) */
export const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach(c => { if (c == null || c === false) return; el.append(c instanceof Node ? c : String(c)); });
    return el;
};

/** SVG 元素建構器（屬性直接 setAttribute；文字用 text） */
const SVG_NS = 'http://www.w3.org/2000/svg';
export const s = (tag, props, ...kids) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'class') el.setAttribute('class', v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
    }
    kids.flat(Infinity).forEach(c => { if (c == null || c === false) return; el.append(c instanceof Node ? c : String(c)); });
    return el;
};

/** 動態 modal（與 index.html 既有 .modal 樣式相同）。回傳 { el, card, open, close } */
export const makeModal = (id, { wide = false, label = '' } = {}) => {
    let el = $(id);
    if (!el) {
        el = h('div', { id, class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || null },
            h('div', { class: 'card' + (wide ? ' wide-card' : '') }));
        el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('visible'); });
        document.body.appendChild(el);
    }
    const card = el.firstElementChild;
    return { el, card, open: () => el.classList.add('visible'), close: () => el.classList.remove('visible') };
};

export const pct = (x) => x == null ? '—' : `${Math.round(x * 100)}%`;
