// 圖鑑／園區分頁：小組與全班的六世界收藏、棲地場景、解鎖、成長、特殊收藏與標籤、XP 設定
import { h, makeModal, fill } from './dom.js';
import { CATALOG, WORLDS, RARITIES, rarityById, worldById, catalogById, CONFIRM_LABEL, GROWTH_TRACKS } from '../data/catalog.js';
import { xpLedger, xpOf, groupKey, milestoneState, DEFAULT_CLASS_MILESTONES } from '../core/xp.js';
import {
    canUnlock, energyOf, makeGrant, revokeGrant, owns, growthStage, stageName, worldProgress, activeGrants, grantId, DEFAULT_COSTS,
    validateSpecialItem, makeSpecialItem, addTag, renameTag, setTagActive, tagImpact, deleteTag, tagName, MAX_TAGS_PER_ITEM,
} from '../core/collection.js';
import { creatureSVG } from '../art/creatures.js';
import { sceneSVG, placeInScene } from '../art/scenes.js';

/**
 * app：{ S, getCurrentClass, studentsOf, dbWrite, notify, uid, localDate, saveClass, afterDataChange, playSound, confetti, reducedMotion }
 */
export const initCollectionUI = (app) => {
    const { S } = app;
    let owner = null;          // { type: 'group'|'class', id }
    let world = 'land';

    const ownerLabel = (c, o) => o.type === 'class' ? '全班' : `第 ${o.id} 小隊`;
    const groupIds = (c) => {
        const ids = new Set(Array.from({ length: c.groupCount || 4 }, (_, i) => String(i + 1)));
        S.grants.filter(g => g.classId === c.id && g.ownerType === 'group').forEach(g => ids.add(String(g.ownerId)));   // 已解散的組別也保留收藏
        return [...ids].sort((a, b) => Number(a) - Number(b));
    };
    const ledgerOf = () => xpLedger(S.events, S.xpEvents);
    const rarityBadge = (rid) => { const r = rarityById.get(rid); return h('span', { class: `rarity r-${rid}`, style: `--rc:${r.color}` }, `${r.icon} ${r.name}`); };
    const specialOf = (c) => S.specialItems.filter(s => s.classId === c.id && !s.archived);
    const itemOf = (c, id) => catalogById.get(id) || S.specialItems.find(s => s.id === id);
    const fakeCatalogItem = (sp) => ({ ...(catalogById.get(sp.baseItemId) || { art: { p: 'sprite', c: '#ffd23f', a: '#fff7cc' }, track: 'animal' }), id: sp.id, name: sp.name, rarity: sp.rarity });

    const saveGrants = async (list) => {
        list.forEach(g => { const i = S.grants.findIndex(x => x.id === g.id); if (i >= 0) S.grants[i] = g; else S.grants.push(g); });
        await app.dbWrite({ grants: list }); app.afterDataChange();
    };

    // ---------------------------------------------------------------- render
    const render = (c) => {
        const tab = document.getElementById('collection-tab'); if (!tab) return;
        const gids = groupIds(c);
        if (!owner || (owner.type === 'group' && !gids.includes(owner.id))) owner = gids.length ? { type: 'group', id: gids[0] } : { type: 'class', id: c.id };
        const ledger = ledgerOf();
        const classXp = xpOf(ledger, 'class', c.id);
        const ms = milestoneState(classXp, DEFAULT_CLASS_MILESTONES);

        const chips = h('div', { class: 'col-owners', role: 'tablist', 'aria-label': '收藏對象' },
            gids.map(g => {
                const xp = xpOf(ledger, 'group', groupKey(c.id, g));
                const dissolved = Number(g) > (c.groupCount || 4);
                return h('button', { class: 'col-owner' + (owner.type === 'group' && owner.id === g ? ' on' : ''), role: 'tab', 'aria-selected': owner.type === 'group' && owner.id === g ? 'true' : 'false',
                    dataset: { owner: g }, onclick: () => { owner = { type: 'group', id: g }; render(c); } },
                    h('span', { text: `⬡ 第 ${g} 小隊${dissolved ? '（已解散）' : ''}` }), h('small', { text: `XP ${xp}` }));
            }),
            h('button', { class: 'col-owner class' + (owner.type === 'class' ? ' on' : ''), role: 'tab', 'aria-selected': owner.type === 'class' ? 'true' : 'false', dataset: { owner: 'class' },
                onclick: () => { owner = { type: 'class', id: c.id }; render(c); } }, h('span', { text: '🏫 全班' }), h('small', { text: `XP ${classXp}` })),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn btn-secondary', id: 'col-settings', text: '⚙️ 圖鑑設定', onclick: () => openSettings(c) }));

        const ownerId = owner.type === 'class' ? c.id : owner.id;
        const energy = energyOf({ ledger, grants: S.grants, c, ownerType: owner.type, ownerId });
        const prog = worldProgress(S.grants, c, owner.type, ownerId);
        const home = owner.type === 'group' ? c.groupWorlds?.[owner.id] : null;
        const summary = h('div', { class: 'col-summary' },
            h('div', { class: 'col-energy' },
                h('span', { class: 'col-energy-v', id: 'col-energy', text: String(energy.available) }), h('span', { class: 'col-energy-l', text: '探索能量' }),
                h('small', { class: 'muted', text: `本期 XP ${energy.earned}・已用 ${energy.spent}` })),
            owner.type === 'group' ? h('label', { class: 'col-home' }, '主題家園 ',
                h('select', { id: 'col-home', 'aria-label': '主題家園', onchange: async (e) => { c.groupWorlds = { ...(c.groupWorlds || {}), [owner.id]: e.target.value || undefined }; if (!e.target.value) delete c.groupWorlds[owner.id]; await app.saveClass(c); render(c); } },
                    h('option', { value: '', text: '（尚未選擇）' }), WORLDS.map(w => h('option', { value: w.id, selected: home === w.id ? true : null, text: `${w.icon} ${w.name}` })))) :
                h('div', { class: 'col-milestones' }, h('span', { text: ms.next ? `下一個班級紀念物：${ms.next.icon} ${ms.next.name}（還差 ${ms.toNext} XP）` : '🎉 全部班級紀念物都完成了！' }),
                    h('div', { class: 'col-ms-row' }, DEFAULT_CLASS_MILESTONES.map(m => h('span', { class: 'col-ms' + (classXp >= m.xp ? ' on' : ''), title: `${m.name}（${m.xp} XP）`, text: `${m.icon} ${m.name}` })))),
            h('div', { class: 'col-progress' }, WORLDS.map(w => h('span', { class: 'col-wp' + (home === w.id ? ' home' : ''), text: `${w.icon} ${prog[w.id]}/12` }))));

        const worldTabs = h('div', { class: 'col-worlds', role: 'tablist', 'aria-label': '世界' },
            WORLDS.map(w => h('button', { class: 'col-world' + (world === w.id ? ' on' : ''), role: 'tab', 'aria-selected': world === w.id ? 'true' : 'false', dataset: { world: w.id },
                onclick: () => { world = w.id; render(c); } }, `${w.icon} ${w.name}${home === w.id ? ' 🏠' : ''}`)),
            h('button', { class: 'col-world special' + (world === 'special' ? ' on' : ''), role: 'tab', 'aria-selected': world === 'special' ? 'true' : 'false', dataset: { world: 'special' },
                onclick: () => { world = 'special'; render(c); } }, '🎖️ 特殊收藏'));

        fill(tab, chips, summary, worldTabs, world === 'special' ? specialView(c, ledger, ownerId) : worldView(c, ledger, ownerId, ms.reached.length, energy));
    };

    const worldView = (c, ledger, ownerId, decor, energy) => {
        const w = worldById.get(world);
        const items = CATALOG.filter(x => x.world === world);
        const { svg, layer } = sceneSVG(world, { decorLevel: decor, label: `${w.name}棲地` });
        const owned = items.filter(it => owns(S.grants, c.id, owner.type, ownerId, it.id));
        owned.forEach((it, i) => {
            const g = S.grants.find(x => x.id === grantId(c.id, owner.type, ownerId, it.id));
            const st = growthStage({ ledger, grant: g }).stage;
            placeInScene(layer, creatureSVG(it, { stage: st }), i, { title: `${it.name}（${stageName(it, st)}）`, onClick: (node) => react(node) });
        });
        // 特殊收藏也住在對應世界
        activeGrants(S.grants, c.id, owner.type, ownerId).filter(g => g.special).forEach((g, j) => {
            const sp = S.specialItems.find(s => s.id === g.itemId); if (!sp) return;
            const base = catalogById.get(sp.baseItemId);
            if ((base?.world || 'fantasy') !== world) return;
            placeInScene(layer, creatureSVG(fakeCatalogItem(sp), { stage: growthStage({ ledger, grant: g }).stage }), owned.length + j, { title: sp.name, onClick: (node) => react(node) });
        });
        const scene = h('div', { class: 'col-scene' }, svg,
            owned.length ? null : h('p', { class: 'col-scene-empty', text: `${w.icon} ${w.name}還沒有夥伴。累積 XP 後，就能解鎖第一位！` }));
        const cards = h('div', { class: 'col-grid' }, items.map(it => itemCard(c, ledger, ownerId, it, energy)));
        return h('div', {}, h('p', { class: 'col-tagline muted', text: `${w.group}・${w.tagline}` }), scene, cards);
    };

    const itemCard = (c, ledger, ownerId, it, energy) => {
        const has = owns(S.grants, c.id, owner.type, ownerId, it.id);
        const chk = has ? null : canUnlock({ ledger, grants: S.grants, c, ownerType: owner.type, ownerId, itemId: it.id });
        const hidden = !has && chk?.locked;
        const g = has ? S.grants.find(x => x.id === grantId(c.id, owner.type, ownerId, it.id)) : null;
        const st = g ? growthStage({ ledger, grant: g }).stage : 0;
        return h('button', { class: `col-card r-${it.rarity}${has ? ' owned' : ''}${chk?.ok ? ' ready' : ''}`, style: `--rc:${rarityById.get(it.rarity).color}`, dataset: { item: it.id },
            'aria-label': `${hidden ? '未揭露的收藏' : it.name}，${rarityById.get(it.rarity).name}，${has ? `已收藏，${stageName(it, st)}` : chk?.ok ? `可以解鎖，需要 ${chk.cost} 能量` : '尚未解鎖'}`,
            onclick: () => openDetail(c, it.id) },
            h('span', { class: 'col-no', text: String(it.no).padStart(2, '0') }),
            creatureSVG(it, { size: 92, silhouette: !has, stage: st }),
            h('span', { class: 'col-name', text: hidden ? '？？？' : it.name }),
            rarityBadge(it.rarity),
            has ? h('span', { class: 'col-stage', text: stageName(it, st) }) : h('span', { class: 'col-cost' + (chk?.ok ? ' ok' : ''), text: `⚡ ${chk?.cost ?? '—'}` }));
    };

    const react = (node) => {
        if (app.reducedMotion()) { node.classList.add('react-still'); setTimeout(() => node.classList.remove('react-still'), 600); return; }
        node.classList.remove('react'); void node.getBoundingClientRect(); node.classList.add('react');
        setTimeout(() => node.classList.remove('react'), 800);
    };

    // ---------------------------------------------------------------- detail
    const detail = makeModal('col-detail-modal', { label: '收藏詳情' });
    const openDetail = (c, itemId) => {
        const ledger = ledgerOf();
        const ownerId = owner.type === 'class' ? c.id : owner.id;
        const special = !catalogById.has(itemId);
        const sp = special ? S.specialItems.find(s => s.id === itemId) : null;
        const it = special ? fakeCatalogItem(sp) : catalogById.get(itemId);
        const g = S.grants.find(x => x.id === grantId(c.id, owner.type, ownerId, itemId));
        const has = g && !g.revoked;
        const chk = has || special ? null : canUnlock({ ledger, grants: S.grants, c, ownerType: owner.type, ownerId, itemId });
        const hidden = !has && chk?.locked;
        const gs = has ? growthStage({ ledger, grant: g }) : null;
        const track = GROWTH_TRACKS[it.track] || GROWTH_TRACKS.animal;
        const artBox = h('div', { class: 'col-detail-art' + (has ? ' owned' : '') }, creatureSVG(it, { size: 180, silhouette: !has, stage: gs?.stage ?? 0 }));
        fill(detail.card, 
            h('h2', { text: hidden ? '？？？' : `${it.name}` }),
            h('div', { class: 'col-detail-meta' }, rarityBadge(it.rarity),
                special ? h('span', { class: 'hw-tag', text: '特殊收藏' }) : h('span', { class: 'hw-tag', text: `${worldById.get(it.world).icon} ${worldById.get(it.world).name} No.${String(it.no).padStart(2, '0')}` }),
                ...(sp?.tagIds || []).map(t => h('span', { class: 'hw-tag tag', text: `🏷️ ${tagName(c, t)}` }))),
            artBox,
            hidden ? h('p', { class: 'muted', text: chk.reason }) : h('p', { class: 'col-fact', text: special ? (sp.note || '班級的特別紀念收藏。') : `📖 ${it.fact}` }),
            has ? h('div', { class: 'col-track', 'aria-label': '成長階段' }, track.map((name, i) => h('span', { class: 'col-step' + (i <= gs.stage ? ' on' : ''), text: name }))) : null,
            has ? h('p', { class: 'muted', text: gs.stage < 3 ? `再累積 ${gs.toNext} XP 進入「${track[gs.stage + 1]}」。照顧夥伴不會消耗分數。` : '🌟 已完成紀錄！' }) : null,
            has ? h('p', { class: 'muted small', text: `${ownerLabel(c, owner)}於 ${app.localDate(g.acquiredAt)} 收藏（${{ xp: `用 ${g.cost} 探索能量解鎖`, teacher: '老師頒發', special: '特殊收藏頒發' }[g.source] || g.source}）${g.note ? `：${g.note}` : ''}` }) : null,
            !special ? h('p', { class: 'muted small', text: `角色設定：${CONFIRM_LABEL[it.confirm]}・🎨 原創佔位插畫（待美術定稿）` }) : null,
            h('div', { class: 'modal-actions wrap' },
                has ? h('button', { class: 'btn btn-success', text: '👋 互動', onclick: () => react(artBox) }) : null,
                !has && !special ? h('button', { class: 'btn btn-primary', id: 'col-unlock', disabled: chk?.ok ? null : true, title: chk?.ok ? null : chk?.reason,
                    text: chk?.ok ? `✨ 解鎖（⚡${chk.cost}）` : `🔒 ${chk?.reason || ''}`, onclick: () => unlock(c, itemId, chk.cost) }) : null,
                !has ? h('button', { class: 'btn btn-secondary', id: 'col-teacher-grant', text: '🎁 老師直接頒發', onclick: () => teacherGrant(c, itemId, special) }) : null,
                has ? h('button', { class: 'btn btn-secondary', id: 'col-revoke', text: '↩ 撤銷誤發', onclick: () => revoke(c, g) }) : null,
                h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => detail.close() })));
        detail.open();
    };

    const celebrate = (c, it) => {
        const ov = makeModal('col-celebrate', { label: '解鎖成功' });
        fill(ov.card, h('div', { class: 'col-celebrate' },
            h('p', { class: 'col-celebrate-t', text: `🎉 ${ownerLabel(c, owner)} 收藏了` }),
            h('div', { class: 'col-celebrate-art' }, creatureSVG(it, { size: 200, stage: 0 })),
            h('p', { class: 'col-celebrate-n' }, `${it.name} `, rarityBadge(it.rarity)),
            h('button', { class: 'btn btn-primary', text: '太棒了！', onclick: () => ov.close() })));
        ov.open();
        app.playSound(it.rarity === 'legendary' || it.rarity === 'epic' ? 'levelup' : 'badge');
        if (!app.reducedMotion()) app.confetti(['⭐', '✨', rarityById.get(it.rarity).icon, '🎉'], it.rarity === 'legendary' ? 60 : 30);
    };
    const unlock = async (c, itemId, cost) => {
        const ownerId = owner.type === 'class' ? c.id : owner.id;
        const chk = canUnlock({ ledger: ledgerOf(), grants: S.grants, c, ownerType: owner.type, ownerId, itemId });
        if (!chk.ok) { app.notify(chk.reason); return; }
        const g = makeGrant({ c, ownerType: owner.type, ownerId, itemId, source: 'xp', cost: chk.cost ?? cost, now: Date.now() }, S.grants);
        if (!g) return;
        await saveGrants([g]);
        detail.close(); render(c); celebrate(c, catalogById.get(itemId));
    };
    const teacherGrant = async (c, itemId, special) => {
        const note = prompt('老師直接頒發（不消耗探索能量）。請填寫原因：', '');
        if (note == null) return;
        if (!note.trim()) { alert('請填寫原因。'); return; }
        const ownerId = owner.type === 'class' ? c.id : owner.id;
        const g = makeGrant({ c, ownerType: owner.type, ownerId, itemId, source: special ? 'special' : 'teacher', note: note.trim(), now: Date.now(), special }, S.grants);
        if (!g) { app.notify('已經收藏了'); return; }
        await saveGrants([g]);
        detail.close(); render(c);
        const it = itemOf(c, itemId); celebrate(c, special ? fakeCatalogItem(it) : it);
    };
    const revoke = async (c, g) => {
        const note = prompt('撤銷這件收藏（只用於「誤發」；扣分或兌換不會收回收藏）。請填寫原因：', '');
        if (note == null) return;
        try { await saveGrants([revokeGrant(g, note, Date.now())]); } catch (err) { alert(err.message); return; }
        detail.close(); render(c); app.notify('已撤銷，紀錄保留');
    };

    // ---------------------------------------------------------------- special collection
    const specialView = (c, ledger, ownerId) => {
        const list = specialOf(c);
        return h('div', {},
            h('div', { class: 'hw-toolbar' },
                h('p', { class: 'muted', style: 'margin:0', text: '特殊收藏有自己的圖鑑，不占基本 12 格；標籤只用來分類，不影響取得方式。' }),
                h('span', { class: 'spacer' }),
                h('button', { class: 'btn btn-primary', id: 'sp-add', text: '＋ 新增特殊收藏', onclick: () => openSpecialEditor(c, null) }),
                h('button', { class: 'btn btn-secondary', id: 'sp-tags', text: '🏷️ 管理標籤', onclick: () => openTags(c) })),
            list.length ? h('div', { class: 'col-grid' }, list.map(sp => {
                const has = owns(S.grants, c.id, owner.type, ownerId, sp.id);
                const it = fakeCatalogItem(sp);
                return h('div', { class: `col-card special r-${sp.rarity}${has ? ' owned' : ''}`, style: `--rc:${rarityById.get(sp.rarity).color}`, dataset: { item: sp.id } },
                    h('button', { class: 'col-card-hit', 'aria-label': `${sp.name}，${has ? '已收藏' : '未收藏'}`, onclick: () => openDetail(c, sp.id) },
                        creatureSVG(it, { size: 84, silhouette: !has, stage: 3 })),
                    h('span', { class: 'col-name', text: sp.name }), rarityBadge(sp.rarity),
                    h('div', { class: 'col-tags' }, (sp.tagIds || []).map(t => h('span', { class: 'hw-tag tag', text: tagName(c, t) }))),
                    h('button', { class: 'btn btn-secondary mini', text: '✏️ 編輯', onclick: () => openSpecialEditor(c, sp) }));
            })) : h('p', { class: 'hw-empty', text: '還沒有特殊收藏。可以為節慶、紀念活動或特殊造型新增。' }));
    };

    const spModal = makeModal('sp-edit-modal', { label: '特殊收藏' });
    const openSpecialEditor = (c, sp) => {
        const prev = sp?.tagIds || [];
        const name = h('input', { id: 'sp-name', type: 'text', maxlength: '20', value: sp?.name || '', placeholder: '例如：聖誕帽貓咪' });
        const rarity = h('select', { id: 'sp-rarity' }, RARITIES.map(r => h('option', { value: r.id, selected: (sp?.rarity || 'rare') === r.id ? true : null, text: `${r.icon} ${r.name}` })));
        const base = h('select', { id: 'sp-base' }, h('option', { value: '', text: '（不對應基本收藏）' }),
            WORLDS.map(w => h('optgroup', { label: `${w.icon} ${w.name}` }, CATALOG.filter(x => x.world === w.id).map(x => h('option', { value: x.id, selected: sp?.baseItemId === x.id ? true : null, text: x.name })))));
        const note = h('input', { id: 'sp-note', type: 'text', maxlength: '60', value: sp?.note || '', placeholder: '說明（選填）' });
        const tagBoxes = c.collectionTags.map(t => {
            const keep = prev.includes(t.id);
            return h('label', { class: 'inline-check' + (!t.active && !keep ? ' disabled' : '') },
                h('input', { type: 'checkbox', class: 'sp-tag', value: t.id, checked: keep ? true : null, disabled: !t.active && !keep ? true : null }),
                ` ${t.name}${t.active ? '' : '（已停用）'}`);
        });
        fill(spModal.card, 
            h('h2', { text: sp ? '✏️ 編輯特殊收藏' : '🎖️ 新增特殊收藏' }),
            h('div', { class: 'field' }, h('label', { for: 'sp-name', text: '名稱' }), name),
            h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', { for: 'sp-rarity', text: '稀有度（固定，不受標籤影響）' }), rarity),
                h('div', { class: 'field' }, h('label', { for: 'sp-base', text: '對應的基本收藏（外觀參考）' }), base)),
            h('div', { class: 'field' }, h('label', { text: `標籤（最多 ${MAX_TAGS_PER_ITEM} 個）` }), h('div', { class: 'sp-tags' }, tagBoxes)),
            h('div', { class: 'field' }, h('label', { for: 'sp-note', text: '說明' }), note),
            h('div', { class: 'modal-actions' },
                h('button', { class: 'btn btn-secondary', text: '取消', onclick: () => spModal.close() }),
                h('button', { class: 'btn btn-primary', id: 'sp-ok', text: '儲存', onclick: async () => {
                    const tagIds = [...spModal.card.querySelectorAll('.sp-tag:checked')].map(i => i.value);
                    const draft = { name: name.value, rarity: rarity.value, tagIds, baseItemId: base.value || null, note: note.value };
                    const errs = validateSpecialItem(draft, c.collectionTags, { isNew: !sp, previousTagIds: prev });
                    if (errs.length) { alert(errs.join('\n')); return; }
                    const now = Date.now();
                    const item = sp ? { ...sp, ...draft, name: draft.name.trim(), note: draft.note.trim(), updatedAt: now } : makeSpecialItem({ classId: c.id, ...draft }, { uid: app.uid, now });
                    const i = S.specialItems.findIndex(x => x.id === item.id); if (i >= 0) S.specialItems[i] = item; else S.specialItems.push(item);
                    await app.dbWrite({ specialItems: [item] }); app.afterDataChange();
                    spModal.close(); render(c);
                } })));
        spModal.open(); name.focus();
    };

    const tagModal = makeModal('tag-modal', { label: '標籤管理' });
    const openTags = (c) => {
        const rows = c.collectionTags.map(t => h('div', { class: 'label-row tag-row', dataset: { tid: t.id } },
            t.builtin ? h('span', { class: 'tag-name', text: `${t.name}（預設）` }) : h('input', { type: 'text', class: 'tag-name-input', value: t.name, maxlength: '10', 'aria-label': '標籤名稱' }),
            h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', class: 'tag-active', checked: t.active ? true : null }), ' 啟用'),
            h('span', { class: 'muted', text: `${tagImpact(specialOf(c), t.id).length} 件` }),
            t.builtin ? null : h('button', { class: 'btn btn-secondary', text: '✕', title: '刪除標籤', onclick: async () => {
                const impacted = tagImpact(S.specialItems.filter(s => s.classId === c.id), t.id);
                if (!confirm(`刪除標籤「${t.name}」？\n會從 ${impacted.length} 件特殊收藏移除這個標籤${impacted.length ? `：${impacted.map(s => s.name).join('、')}` : ''}。\n收藏本身不會被刪除。`)) return;
                if (!confirm(`再確認一次：真的要刪除「${t.name}」嗎？`)) return;
                const { updatedItems } = deleteTag(c, S.specialItems.filter(s => s.classId === c.id), t.id, Date.now());
                updatedItems.forEach(u => { const i = S.specialItems.findIndex(x => x.id === u.id); S.specialItems[i] = u; });
                if (updatedItems.length) await app.dbWrite({ specialItems: updatedItems });
                await app.saveClass(c); openTags(c); render(c);
            } })));
        const add = h('input', { type: 'text', id: 'tag-new', maxlength: '10', placeholder: '新標籤名稱' });
        fill(tagModal.card, 
            h('h2', { text: '🏷️ 特殊收藏標籤' }),
            h('p', { class: 'modal-sub', text: '預設標籤可以停用但不能刪除；停用後舊收藏仍顯示，新收藏不能選。自訂標籤可改名或刪除（刪除前會顯示影響並確認兩次）。' }),
            h('div', {}, rows),
            h('div', { class: 'label-row' }, add, h('button', { class: 'btn btn-secondary', text: '＋ 新增', onclick: async () => {
                try { addTag(c, add.value, `tag-${app.uid()}`); await app.saveClass(c); openTags(c); } catch (err) { alert(err.message); }
            } })),
            h('div', { class: 'modal-actions' },
                h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => tagModal.close() }),
                h('button', { class: 'btn btn-primary', id: 'tag-ok', text: '儲存', onclick: async () => {
                    try {
                        for (const row of tagModal.card.querySelectorAll('.tag-row')) {
                            const tid = row.dataset.tid;
                            const input = row.querySelector('.tag-name-input');
                            if (input) renameTag(c, tid, input.value);
                            setTagActive(c, tid, row.querySelector('.tag-active').checked);
                        }
                        await app.saveClass(c); tagModal.close(); render(c); app.notify('標籤已儲存');
                    } catch (err) { alert(err.message); }
                } })));
        tagModal.open();
    };

    // ---------------------------------------------------------------- settings
    const setModal = makeModal('col-settings-modal', { label: '圖鑑設定' });
    const openSettings = (c) => {
        const col = c.collection || { mode: 'sequential', costs: { ...DEFAULT_COSTS }, periodStart: 0 };
        const mode = h('select', { id: 'col-mode' }, h('option', { value: 'sequential', selected: col.mode !== 'free' ? true : null, text: '逐步揭露：同一世界先收齊較低稀有度' }),
            h('option', { value: 'free', selected: col.mode === 'free' ? true : null, text: '自由選擇：可直接解鎖任何收藏' }));
        const costInputs = RARITIES.map(r => h('label', { class: 'inline-check' }, `${r.icon} ${r.name}`, h('input', { type: 'number', min: '1', max: '500', class: 'col-cost-in', dataset: { r: r.id }, value: col.costs?.[r.id] ?? DEFAULT_COSTS[r.id], style: 'max-width:5.5em' })));
        const bonusAmt = h('input', { type: 'number', id: 'col-bonus-xp', min: '1', max: '100', value: '5', style: 'max-width:5em' });
        const bonusReason = h('input', { type: 'text', id: 'col-bonus-reason', maxlength: '30', placeholder: '原因，例如：全班合作完成大掃除' });
        fill(setModal.card, 
            h('h2', { text: '⚙️ 圖鑑設定' }),
            h('div', { class: 'field' }, h('label', { for: 'col-mode', text: '解鎖方式' }), mode),
            h('div', { class: 'field' }, h('label', { text: '各稀有度需要的探索能量（所有世界相同，主題家園沒有加成）' }), h('div', { class: 'col-costs' }, costInputs)),
            h('h3', { class: 'hw-sec', text: '🏫 頒發 XP' }),
            h('p', { class: 'modal-sub', text: '個人加分會自動計入「當時所屬小隊」與全班 XP；小隊加分只算一次，不乘人數；扣分與兌換不影響 XP。也可以手動頒發：' }),
            h('div', { class: 'label-row' }, h('select', { id: 'col-bonus-scope' }, h('option', { value: 'class', text: '全班' }), groupIds(c).map(g => h('option', { value: g, text: `第 ${g} 小隊` }))), bonusAmt, bonusReason,
                h('button', { class: 'btn btn-success', id: 'col-bonus-ok', text: '頒發', style: 'width:auto', onclick: () => grantXp(c) })),
            h('h3', { class: 'hw-sec', text: '🔄 新的獎勵期間' }),
            h('p', { class: 'modal-sub', text: `開始新期間後，探索能量從 0 重新累積；已收藏的夥伴、成長階段與歷史紀錄全部保留。${col.periodStart ? `目前期間自 ${app.localDate(col.periodStart)} 開始。` : ''}` }),
            h('button', { class: 'btn btn-secondary', id: 'col-new-period', text: '開始新的獎勵期間', onclick: async () => {
                if (!confirm('開始新的獎勵期間？探索能量會從 0 開始，收藏不會消失。')) return;
                if (!confirm('再確認一次：開始新的獎勵期間？')) return;
                c.collection = { ...col, periodStart: Date.now() }; await app.saveClass(c); setModal.close(); render(c); app.notify('已開始新的獎勵期間');
            } }),
            h('div', { class: 'modal-actions' },
                h('button', { class: 'btn btn-secondary', text: '取消', onclick: () => setModal.close() }),
                h('button', { class: 'btn btn-primary', id: 'col-settings-ok', text: '儲存', onclick: async () => {
                    const costs = {};
                    for (const i of setModal.card.querySelectorAll('.col-cost-in')) { const v = parseInt(i.value, 10); if (!(v >= 1 && v <= 500)) { alert('探索能量請輸入 1–500'); return; } costs[i.dataset.r] = v; }
                    c.collection = { ...col, mode: mode.value, costs }; await app.saveClass(c); setModal.close(); render(c); app.notify('圖鑑設定已儲存');
                } })));
        setModal.open();
    };
    const grantXp = async (c) => {
        const scope = document.getElementById('col-bonus-scope').value;
        const amt = parseInt(document.getElementById('col-bonus-xp').value, 10);
        const reason = document.getElementById('col-bonus-reason').value.trim();
        if (!(amt >= 1 && amt <= 100)) { alert('XP 請輸入 1–100'); return; }
        if (!reason) { alert('請填寫原因'); return; }
        const now = Date.now();
        const xe = { id: `xp-${app.uid()}`, classId: c.id, scope: scope === 'class' ? 'class' : 'group', scopeId: scope === 'class' ? c.id : scope, delta: amt, reason, source: 'manual', sourceId: null, ts: now, date: app.localDate(now), voided: false };
        S.xpEvents.push(xe); await app.dbWrite({ xpEvents: [xe] }); app.afterDataChange();
        setModal.close(); render(c); app.notify(`${scope === 'class' ? '全班' : `第 ${scope} 小隊`} XP +${amt}`);
    };

    return { render, reset: () => { /* 保留目前選擇 */ } };
};
