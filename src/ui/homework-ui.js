// 作業分頁 UI：今日作業、匿名統計（投影安全）、教師矩陣、批次登記、追蹤清單、個人歷程、作業類別設定
import { h, makeModal, pct, fill } from './dom.js';
import {
    SUBMISSION, CORRECTION, SUBMISSION_ICON, CORRECTION_ICON, projectRecords, getRecord, buildChangeEvents, buildUndoBatch, buildResolveEvent,
    assignmentStats, followUpLists, studentHistory, lastUndoableBatch, addHwType, renameHwType, setHwTypeActive, canDeleteHwType, typeName, makeAssignment, copyAssignments,
} from '../core/homework.js';

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * app：index.html 傳入的應用程式介面
 *  { S, getCurrentClass, studentsOf, studentById, seatName, dbWrite, notify, uid, localDate, localTime, mdLabel, addDays,
 *    deviceId, saveClass, afterDataChange, downloadCSV, stampForFile }
 */
export const initHomeworkUI = (app) => {
    const { S } = app;
    let date = null;              // 目前檢視日期
    let teacherView = false;      // 預設投影安全（匿名）；每次進入分頁都重設
    let showArchived = false;
    const selected = new Set();   // 批次選取的學生
    let records = new Map();

    const assignmentsOf = (c) => S.hwAssignments.filter(a => a.classId === c.id);
    const eventsOf = (c) => S.hwEvents.filter(e => e.classId === c.id);
    const refreshRecords = (c) => { records = projectRecords(eventsOf(c), assignmentsOf(c)); return records; };
    const ctx = () => { const now = Date.now(); return { uid: app.uid, now, date: app.localDate(now), deviceId: app.deviceId() }; };
    const aLabel = (c, a) => `${typeName(c, a.typeId)}${a.title ? ` ${a.title}` : ''}`;

    const writeEvents = async (events) => {
        if (!events.length) return;
        S.hwEvents.push(...events);
        await app.dbWrite({ hwEvents: events });
        app.afterDataChange();
    };
    const saveAssignments = async (list) => {
        list.forEach(a => { a.updatedAt = Date.now(); const i = S.hwAssignments.findIndex(x => x.id === a.id); if (i >= 0) S.hwAssignments[i] = a; else S.hwAssignments.push(a); });
        await app.dbWrite({ hwAssignments: list });
        app.afterDataChange();
    };

    /** 套用變更（單格或批次），回傳產生的事件數 */
    const change = async (c, assignmentId, studentIds, field, value) => {
        refreshRecords(c);
        const out = buildChangeEvents({ records, classId: c.id, assignmentId, studentIds, field, value }, ctx());
        await writeEvents(out.events);
        if (out.rejected.length) app.notify(`${out.rejected.length} 位略過：${out.rejected[0].error}`, 4000);
        return out;
    };

    // ---------------------------------------------------------------- render
    const render = (c) => {
        const tab = document.getElementById('homework-tab');
        if (!tab) return;
        if (!date) date = app.localDate();
        refreshRecords(c);
        const students = app.studentsOf(c.id);
        const sids = students.map(s => s.id);
        const all = assignmentsOf(c);
        const todays = all.filter(a => a.assignedDate === date && (showArchived || !a.archived)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const today = app.localDate();

        const toolbar = h('div', { class: 'hw-toolbar' },
            h('div', { class: 'field inline' }, h('label', { for: 'hw-date', text: '作業日期' }),
                h('input', { type: 'date', id: 'hw-date', value: date, onchange: (e) => { if (e.target.value) { date = e.target.value; render(c); } } })),
            h('button', { class: 'btn btn-secondary', title: '前一天', 'aria-label': '前一天', text: '◀', onclick: () => { date = app.addDays(date, -1); render(c); } }),
            h('button', { class: 'btn btn-secondary', title: '後一天', 'aria-label': '後一天', text: '▶', onclick: () => { date = app.addDays(date, 1); render(c); } }),
            h('button', { class: 'btn btn-secondary', text: '今天', disabled: date === today ? true : null, onclick: () => { date = today; render(c); } }),
            h('span', { class: 'spacer' }),
            teacherView ? h('button', { class: 'btn btn-primary', id: 'hw-add', text: '＋ 新增作業', onclick: () => openAssignmentEditor(c, null) }) : null,
            teacherView ? h('button', { class: 'btn btn-secondary', id: 'hw-copy-prev', text: '📋 複製前一天', onclick: () => copyPrev(c) }) : null,
            teacherView ? h('button', { class: 'btn btn-secondary', id: 'hw-settings', text: '⚙️ 作業設定', onclick: () => openSettings(c) }) : null,
            teacherView ? h('button', { class: 'btn btn-secondary', id: 'hw-stats', text: '📊 統計', onclick: () => openStats(c) }) : null,
            h('button', { class: 'btn ' + (teacherView ? 'btn-heart' : 'btn-secondary'), id: 'hw-view-toggle', 'aria-pressed': teacherView ? 'true' : 'false',
                text: teacherView ? '🙈 回到投影模式' : '🔒 教師檢視（顯示姓名）', onclick: () => { teacherView = !teacherView; selected.clear(); render(c); } }));

        const banner = teacherView
            ? h('p', { class: 'hw-banner teacher', role: 'status', text: '🔒 教師檢視：畫面會顯示學生姓名與未交紀錄，請勿投影給全班。' })
            : h('p', { class: 'hw-banner public', role: 'status', text: '📽️ 投影模式：只顯示匿名統計，不會出現任何學生姓名。' });

        const cards = todays.length
            ? h('div', { class: 'hw-cards' }, todays.map(a => assignmentCard(c, a, sids)))
            : h('p', { class: 'hw-empty', text: teacherView ? `${app.mdLabel(date)} 還沒有作業。按「＋ 新增作業」或「📋 複製前一天」。` : `${app.mdLabel(date)} 沒有作業紀錄。` });

        const parts = [toolbar, banner, cards];
        if (teacherView) {
            const visible = todays.filter(a => !a.archived);
            if (visible.length) parts.push(matrix(c, visible, students));
            parts.push(followUp(c, sids));
            const archivedCount = all.filter(a => a.assignedDate === date && a.archived).length;
            if (archivedCount || showArchived) parts.push(h('label', { class: 'hw-archived-toggle' },
                h('input', { type: 'checkbox', checked: showArchived ? true : null, onchange: (e) => { showArchived = e.target.checked; render(c); } }),
                ` 顯示已封存（${archivedCount}）`));
        }
        fill(tab, ...parts);
    };

    const statBar = (label, value, cls = '') => h('div', { class: 'hw-stat ' + cls }, h('span', { class: 'hw-stat-v', text: value }), h('span', { class: 'hw-stat-l', text: label }));
    const assignmentCard = (c, a, sids) => {
        const st = assignmentStats(records, a.id, sids);
        const bonusId = `hwbonus|${a.id}`;
        const bonusGiven = S.xpEvents.some(x => x.id === bonusId && !x.voided);
        return h('div', { class: 'hw-card' + (a.archived ? ' archived' : ''), dataset: { aid: a.id } },
            h('div', { class: 'hw-card-head' },
                h('span', { class: 'hw-type', text: typeName(c, a.typeId) }),
                h('span', { class: 'hw-title', text: a.title || '' }),
                a.archived ? h('span', { class: 'hw-tag', text: '已封存' }) : null),
            h('div', { class: 'hw-meta', text: [a.dueDate ? `期限 ${app.mdLabel(a.dueDate)}` : '未設期限', a.note].filter(Boolean).join('・') }),
            h('div', { class: 'hw-progress', role: 'img', 'aria-label': `已交 ${st.submitted}，應交 ${st.expected}` },
                h('div', { class: 'hw-progress-fill', style: `width:${st.expected ? Math.round((st.submitted / st.expected) * 100) : 0}%` })),
            h('div', { class: 'hw-stats' },
                statBar('已交 / 應交', `${st.submitted} / ${st.expected}`, 'big'),
                statBar('繳交率', pct(st.submitRate)),
                statBar('已登記', pct(st.coverage)),
                statBar('訂正完成', pct(st.correctionRate)),
                st.late ? statBar('補交', String(st.late)) : null),
            teacherView ? h('div', { class: 'hw-card-actions' },
                h('button', { class: 'btn btn-secondary row-btn', text: '✏️ 編輯', onclick: () => openAssignmentEditor(c, a) }),
                h('button', { class: 'btn btn-secondary row-btn', text: a.archived ? '↩ 還原' : '🗄 封存', onclick: () => toggleArchive(c, a) }),
                c.hwReward?.enabled && st.allIn && !bonusGiven
                    ? h('button', { class: 'btn btn-success row-btn', text: `🎉 全班交齊：全班 XP +${c.hwReward.xp}`, onclick: () => grantBonus(c, a) }) : null,
                bonusGiven ? h('span', { class: 'hw-tag good', text: '🎉 已頒發全班交齊獎勵' }) : null) : null,
            !teacherView && st.allIn ? h('div', { class: 'hw-allin', text: '🎉 全班交齊！' }) : null);
    };

    // ---------------------------------------------------------------- matrix (teacher)
    const cellText = (r) => {
        const sub = `${SUBMISSION_ICON[r.submission]} ${SUBMISSION[r.submission]}`;
        const cor = r.submission === 'submitted' && r.correction ? `${CORRECTION_ICON[r.correction]} ${CORRECTION[r.correction]}` : '';
        return [sub, cor];
    };
    const matrix = (c, list, students) => {
        const allSel = students.length > 0 && students.every(s => selected.has(s.id));
        const head = h('tr', {},
            h('th', {}, h('input', { type: 'checkbox', 'aria-label': '全選', checked: allSel ? true : null, onchange: (e) => { students.forEach(s => e.target.checked ? selected.add(s.id) : selected.delete(s.id)); render(c); } })),
            h('th', { text: '座號' }), h('th', { class: 'left', text: '姓名' }),
            list.map(a => h('th', { class: 'hw-col' }, h('div', { text: aLabel(c, a) }),
                h('button', { class: 'btn btn-secondary mini', text: '其餘未登記→未交', title: '把這份作業仍是「未登記」的同學設成「未交」',
                    onclick: async () => {
                        const rest = students.filter(s => getRecord(records, a.id, s.id).submission === 'unchecked').map(s => s.id);
                        if (!rest.length) { app.notify('沒有未登記的同學'); return; }
                        if (!confirm(`把 ${rest.length} 位「未登記」設為「未交」？`)) return;
                        await change(c, a.id, rest, 'submission', 'missing'); render(c);
                    } }))));
        const rows = students.map(s => h('tr', { class: selected.has(s.id) ? 'sel' : '' },
            h('td', {}, h('input', { type: 'checkbox', 'aria-label': `選取 ${s.name}`, checked: selected.has(s.id) ? true : null,
                onchange: (e) => { e.target.checked ? selected.add(s.id) : selected.delete(s.id); render(c); } })),
            h('td', { text: s.seat ?? '' }),
            h('td', { class: 'left' }, h('button', { class: 'linkish', text: s.name, title: '查看作業歷程', onclick: () => openStudent(c, s) })),
            list.map(a => {
                const r = getRecord(records, a.id, s.id);
                const [t1, t2] = cellText(r);
                return h('td', {}, h('button', {
                    class: `hw-cell sub-${r.submission}${r.correction ? ` cor-${r.correction}` : ''}${r.conflict ? ' conflict' : ''}`,
                    dataset: { aid: a.id, sid: s.id }, 'aria-label': `${s.name} ${aLabel(c, a)}：${t1}${t2 ? `，${t2}` : ''}${r.conflict ? '，同步衝突' : ''}`,
                    onclick: () => openCell(c, a, s),
                }, h('span', { text: t1 }), t2 ? h('small', { text: t2 }) : null, r.late ? h('small', { class: 'late', text: '補交' }) : null, r.conflict ? h('small', { class: 'warn', text: '⚠ 衝突' }) : null));
            })));
        const batch = h('div', { class: 'hw-batch', hidden: selected.size ? null : true },
            h('span', { text: `已選 ${selected.size} 位` }),
            list.length > 1 ? h('select', { id: 'hw-batch-assign', 'aria-label': '套用到哪份作業' }, list.map(a => h('option', { value: a.id, text: aLabel(c, a) }))) : null,
            ...Object.entries(SUBMISSION).map(([k, v]) => h('button', { class: 'btn btn-secondary mini', dataset: { batch: k }, text: `→ ${v}`, onclick: () => applyBatch(c, list, 'submission', k) })),
            h('span', { class: 'sep' }),
            ...Object.entries(CORRECTION).map(([k, v]) => h('button', { class: 'btn btn-secondary mini', dataset: { batchCor: k }, text: `→ ${v}`, onclick: () => applyBatch(c, list, 'correction', k) })),
            h('button', { class: 'btn btn-secondary mini', text: '取消選取', onclick: () => { selected.clear(); render(c); } }));
        const lb = lastUndoableBatch(eventsOf(c), app.localDate());
        const lbLabel = lb ? `${(lb.field === 'submission' ? SUBMISSION : CORRECTION)[lb.value]} × ${lb.n}` : '';
        const undo = h('button', { class: 'btn btn-secondary', id: 'hw-undo-batch', disabled: lb ? null : true,
            text: lb ? `↶ 復原上一批（${lbLabel}）` : '↶ 復原上一批', title: lb ? null : '今天沒有可以復原的批次', onclick: () => undoBatch(c, lb, lbLabel) });
        return h('div', { class: 'hw-matrix-wrap' },
            h('div', { class: 'hw-matrix-tools' }, undo, h('span', { class: 'muted', text: '點格子改狀態；勾選多位可批次登記。未登記 ≠ 未交。' })),
            batch,
            h('div', { class: 'table-wrap' }, h('table', { class: 'data-table hw-matrix' }, h('thead', {}, head), h('tbody', {}, rows))));
    };
    const applyBatch = async (c, list, field, value) => {
        const aid = list.length > 1 ? document.getElementById('hw-batch-assign').value : list[0].id;
        const out = await change(c, aid, [...selected], field, value);
        app.notify(`已更新 ${out.events.length} 位${out.unchanged ? `，${out.unchanged} 位原本就是這個狀態` : ''}`);
        selected.clear(); render(c);
    };
    const undoBatch = async (c, lb, lbLabel) => {
        if (!lb) return;
        if (!confirm(`復原上一批：${lbLabel}？\n原紀錄會保留在歷程中。`)) return;
        refreshRecords(c);
        const out = buildUndoBatch({ hwEvents: eventsOf(c), records, batchId: lb.batchId }, ctx());
        await writeEvents(out.events);
        app.notify(`已復原 ${out.events.length} 筆${out.skipped.length ? `；${out.skipped.length} 筆之後已被修改，保留不動` : ''}`, 4000);
        render(c);
    };

    // ---------------------------------------------------------------- cell editor
    const cellModal = makeModal('hw-cell-modal', { label: '作業狀態' });
    const openCell = (c, a, s) => {
        refreshRecords(c);
        const r = getRecord(records, a.id, s.id);
        const set = async (field, value) => { await change(c, a.id, [s.id], field, value); cellModal.close(); render(c); };
        const hist = eventsOf(c).filter(e => e.assignmentId === a.id && e.studentId === s.id).sort((x, y) => y.ts - x.ts);
        fill(cellModal.card, 
            h('h2', { text: `${s.seat ?? ''}號 ${s.name}` }),
            h('p', { class: 'modal-sub', text: `${aLabel(c, a)}${a.dueDate ? `（期限 ${app.mdLabel(a.dueDate)}）` : ''}` }),
            r.conflict ? h('div', { class: 'hw-conflict' },
                h('p', { text: '⚠ 兩台裝置對這一格做了不同的修改，請選擇正確的狀態：' }),
                r.conflict.options.map(o => h('button', { class: 'btn btn-heart', text: `${(r.conflict.field === 'submission' ? SUBMISSION : CORRECTION)[o.value]}（${app.localTime(o.ts)}${o.deviceId ? `・${o.deviceId.slice(0, 6)}` : ''}）`,
                    onclick: async () => { await writeEvents([buildResolveEvent({ records, classId: c.id, assignmentId: a.id, studentId: s.id, field: r.conflict.field, value: o.value }, ctx())]); cellModal.close(); render(c); } }))) : null,
            h('h3', { class: 'hw-sec', text: '繳交' }),
            h('div', { class: 'reason-grid' }, Object.entries(SUBMISSION).map(([k, v]) => h('button', {
                class: `btn reason-btn ${r.submission === k ? 'btn-primary' : 'btn-secondary'}`, dataset: { sub: k }, 'aria-pressed': r.submission === k ? 'true' : 'false',
                text: `${SUBMISSION_ICON[k]} ${v}`, onclick: () => set('submission', k) }))),
            h('h3', { class: 'hw-sec', text: '訂正' }),
            r.submission !== 'submitted' ? h('p', { class: 'muted', text: '先標記「已交」才能設定訂正。' }) : null,
            h('div', { class: 'reason-grid' }, Object.entries(CORRECTION).map(([k, v]) => h('button', {
                class: `btn reason-btn ${r.correction === k ? 'btn-primary' : 'btn-secondary'}`, dataset: { cor: k }, 'aria-pressed': r.correction === k ? 'true' : 'false',
                disabled: r.submission === 'submitted' ? null : true, text: `${CORRECTION_ICON[k]} ${v}`, onclick: () => set('correction', k) }))),
            r.submittedDate ? h('p', { class: 'muted', text: `交件：${app.mdLabel(r.submittedDate)} ${app.localTime(r.submittedAt)}${r.late ? '（補交）' : ''}${r.correctedAt ? `・訂正完成：${app.localTime(r.correctedAt)}` : ''}` }) : null,
            hist.length ? h('details', { class: 'hw-hist' }, h('summary', { text: `歷程（${hist.length}）` }),
                h('ul', {}, hist.map(e => h('li', { text: `${app.mdLabel(e.date)} ${app.localTime(e.ts)}　${e.field === 'submission' ? '繳交' : '訂正'}：${label(e.field, e.prev)} → ${label(e.field, e.value)}${e.reason ? `（${e.reason}）` : ''}` })))) : null,
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => cellModal.close() })));
        cellModal.open();
        cellModal.card.querySelector('[aria-pressed="true"]')?.focus();
    };
    const label = (field, v) => v == null ? '—' : (field === 'submission' ? SUBMISSION : CORRECTION)[v] || v;

    // ---------------------------------------------------------------- follow-up lists (teacher)
    const followUp = (c, sids) => {
        const active = assignmentsOf(c).filter(a => !a.archived);
        const l = followUpLists(records, active, sids);
        const conflicts = [];
        for (const a of active) for (const sid of sids) { const r = getRecord(records, a.id, sid); if (r.conflict) conflicts.push({ a, sid }); }
        const row = (x, btn) => {
            const s = app.studentById(x.studentId ?? x.sid); const a = x.assignment ?? x.a;
            return h('li', {}, h('span', { text: `${app.seatName(s)}　${aLabel(c, a)}（${app.mdLabel(a.assignedDate)}${a.dueDate ? `，期限 ${app.mdLabel(a.dueDate)}` : ''}）` }), btn ? btn(a, s) : null);
        };
        const uncheckedByAssignment = new Map();
        l.unchecked.forEach(x => uncheckedByAssignment.set(x.assignment.id, (uncheckedByAssignment.get(x.assignment.id) || 0) + 1));
        return h('div', { class: 'hw-follow' },
            h('div', { class: 'hw-follow-col' }, h('h3', { text: `📮 待補交（${l.missing.length}）` }),
                l.missing.length ? h('ul', {}, l.missing.map(x => row(x, (a, s) => h('button', { class: 'btn btn-success mini', text: '補交了', onclick: async () => { await change(c, a.id, [s.id], 'submission', 'submitted'); render(c); } })))) : h('p', { class: 'muted', text: '沒有待補交' })),
            h('div', { class: 'hw-follow-col' }, h('h3', { text: `✎ 待訂正（${l.needs.length}）` }),
                l.needs.length ? h('ul', {}, l.needs.map(x => row(x, (a, s) => h('button', { class: 'btn btn-success mini', text: '已訂正', onclick: async () => { await change(c, a.id, [s.id], 'correction', 'done'); render(c); } })))) : h('p', { class: 'muted', text: '沒有待訂正' })),
            h('div', { class: 'hw-follow-col' }, h('h3', { text: '· 尚未登記（不算未交）' }),
                uncheckedByAssignment.size ? h('ul', {}, [...uncheckedByAssignment].map(([aid, n]) => { const a = active.find(x => x.id === aid); return h('li', { text: `${app.mdLabel(a.assignedDate)} ${aLabel(c, a)}：${n} 位未登記` }); })) : h('p', { class: 'muted', text: '全部都已登記' }),
                conflicts.length ? h('h3', { class: 'warn', text: `⚠ 同步衝突（${conflicts.length}）` }) : null,
                conflicts.length ? h('ul', {}, conflicts.map(x => row(x, (a, s) => h('button', { class: 'btn btn-heart mini', text: '處理', onclick: () => openCell(c, a, s) })))) : null));
    };

    // ---------------------------------------------------------------- assignment editor
    const editModal = makeModal('hw-edit-modal', { label: '作業' });
    const openAssignmentEditor = (c, a) => {
        const types = c.hwTypes.filter(t => t.active || t.id === a?.typeId);
        const f = {
            type: h('select', { id: 'hw-f-type' }, types.map(t => h('option', { value: t.id, text: t.name + (t.active ? '' : '（已停用）'), selected: a?.typeId === t.id ? true : null }))),
            title: h('input', { id: 'hw-f-title', type: 'text', maxlength: '40', placeholder: '例如：L6 P18–21', value: a?.title || '' }),
            note: h('input', { id: 'hw-f-note', type: 'text', maxlength: '80', placeholder: '選填', value: a?.note || '' }),
            assigned: h('input', { id: 'hw-f-assigned', type: 'date', value: a?.assignedDate || date }),
            due: h('input', { id: 'hw-f-due', type: 'date', value: a?.dueDate || app.addDays(a?.assignedDate || date, 1) }),
        };
        const field = (lab, input, id) => h('div', { class: 'field' }, h('label', { for: id, text: lab }), input);
        fill(editModal.card, 
            h('h2', { text: a ? '✏️ 編輯作業' : '📚 新增作業' }),
            field('作業類別', f.type, 'hw-f-type'), field('範圍／標題', f.title, 'hw-f-title'), field('說明', f.note, 'hw-f-note'),
            h('div', { class: 'field-row' }, field('指派日期', f.assigned, 'hw-f-assigned'), field('繳交期限', f.due, 'hw-f-due')),
            h('div', { class: 'modal-actions' },
                h('button', { class: 'btn btn-secondary', text: '取消', onclick: () => editModal.close() }),
                h('button', { class: 'btn btn-primary', id: 'hw-f-ok', text: '儲存', onclick: async () => {
                    try {
                        const now = Date.now();
                        const base = makeAssignment({ classId: c.id, typeId: f.type.value, title: f.title.value, note: f.note.value, assignedDate: f.assigned.value, dueDate: f.due.value || null }, { uid: app.uid, now });
                        const out = a ? { ...a, typeId: base.typeId, title: base.title, note: base.note, assignedDate: base.assignedDate, dueDate: base.dueDate } : base;
                        await saveAssignments([out]);
                        date = out.assignedDate; editModal.close(); render(c);
                        app.notify(a ? '作業已更新' : `已新增：${aLabel(c, out)}`);
                    } catch (err) { alert(err.message); }
                } })));
        editModal.open(); f.title.focus();
    };
    const toggleArchive = async (c, a) => {
        if (!a.archived && !confirm(`封存「${aLabel(c, a)}」？\n紀錄會保留，可隨時還原。`)) return;
        await saveAssignments([{ ...a, archived: !a.archived }]);
        render(c);
    };
    const copyPrev = async (c) => {
        const src = [...new Set(assignmentsOf(c).filter(a => a.assignedDate < date && !a.archived).map(a => a.assignedDate))].sort().pop();
        if (!src) { app.notify('之前沒有可以複製的作業'); return; }
        const list = copyAssignments(assignmentsOf(c), src, date, app.addDays, daysBetween, { uid: app.uid, now: Date.now() });
        if (!confirm(`把 ${app.mdLabel(src)} 的 ${list.length} 份作業複製到 ${app.mdLabel(date)}？`)) return;
        await saveAssignments(list); render(c);
        app.notify(`已複製 ${list.length} 份作業`);
    };
    const grantBonus = async (c, a) => {
        const id = `hwbonus|${a.id}`;
        if (S.xpEvents.some(x => x.id === id)) return;
        const now = Date.now();
        const xe = { id, classId: c.id, scope: 'class', scopeId: c.id, delta: Number(c.hwReward.xp) || 0, reason: `作業全班交齊：${aLabel(c, a)}`, source: 'hw-bonus', sourceId: a.id, ts: now, date: app.localDate(now), voided: false };
        S.xpEvents.push(xe);
        await app.dbWrite({ xpEvents: [xe] });
        app.afterDataChange();
        app.notify(`🎉 全班 XP +${xe.delta}`);
        render(c);
    };

    // ---------------------------------------------------------------- student history (teacher)
    const studentModal = makeModal('hw-student-modal', { wide: true, label: '學生作業歷程' });
    const openStudent = (c, s) => {
        refreshRecords(c);
        const byId = new Map(assignmentsOf(c).map(a => [a.id, a]));
        const evs = studentHistory(eventsOf(c), s.id);
        const active = assignmentsOf(c).filter(a => !a.archived);
        const sum = { missing: 0, late: 0, needs: 0, done: 0 };
        active.forEach(a => { const r = getRecord(records, a.id, s.id); if (r.submission === 'missing') sum.missing++; if (r.late) sum.late++; if (r.correction === 'needs') sum.needs++; if (r.correction === 'done') sum.done++; });
        fill(studentModal.card, 
            h('h2', { text: `📚 ${app.seatName(s)} 的作業` }),
            h('div', { class: 'timeline-head' }, h('span', { text: `待補交 ${sum.missing}` }), h('span', { text: `補交 ${sum.late}` }), h('span', { text: `待訂正 ${sum.needs}` }), h('span', { text: `已訂正 ${sum.done}` })),
            h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
                h('thead', {}, h('tr', {}, ['日期', '時間', '作業', '項目', '變更', '備註'].map(t => h('th', { text: t })))),
                h('tbody', {}, evs.length ? evs.map(e => { const a = byId.get(e.assignmentId); return h('tr', {},
                    h('td', { text: app.mdLabel(e.date) }), h('td', { text: app.localTime(e.ts) }), h('td', { class: 'left', text: a ? aLabel(c, a) : '（已刪除）' }),
                    h('td', { text: e.field === 'submission' ? '繳交' : '訂正' }), h('td', { text: `${label(e.field, e.prev)} → ${label(e.field, e.value)}` }), h('td', { class: 'muted', text: e.reason || '' })); })
                    : h('tr', {}, h('td', { colspan: '6', class: 'muted', text: '還沒有作業紀錄' }))))),
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', text: '關閉', onclick: () => studentModal.close() })));
        studentModal.open();
    };

    // ---------------------------------------------------------------- statistics (teacher)
    const statsModal = makeModal('hw-stats-modal', { wide: true, label: '作業統計' });
    const openStats = (c, days = 30) => {
        refreshRecords(c);
        const from = app.addDays(app.localDate(), -days + 1);
        const list = assignmentsOf(c).filter(a => !a.archived && a.assignedDate >= from);
        const students = app.studentsOf(c.id); const sids = students.map(s => s.id);
        const byType = new Map();
        for (const a of list) {
            const st = assignmentStats(records, a.id, sids);
            const t = byType.get(a.typeId) || { n: 0, submitted: 0, missing: 0, needs: 0, done: 0, late: 0 };
            t.n++; t.submitted += st.submitted; t.missing += st.missing; t.needs += st.needs; t.done += st.done; t.late += st.late;
            byType.set(a.typeId, t);
        }
        const perStudent = students.map(s => {
            const r = { s, missing: 0, late: 0, needs: 0, done: 0 };
            list.forEach(a => { const x = getRecord(records, a.id, s.id); if (x.submission === 'missing') r.missing++; if (x.late) r.late++; if (x.correction === 'needs') r.needs++; if (x.correction === 'done') r.done++; });
            return r;
        });
        const ratio = (a, b) => pct(b ? a / b : null);
        fill(statsModal.card, 
            h('h2', { text: `📊 作業統計（近 ${days} 天，${list.length} 份）` }),
            h('div', { class: 'hw-toolbar' }, [7, 30, 90].map(d => h('button', { class: 'btn ' + (d === days ? 'btn-primary' : 'btn-secondary'), text: `近 ${d} 天`, onclick: () => openStats(c, d) })),
                h('span', { class: 'spacer' }),
                h('button', { class: 'btn btn-secondary', text: '⬇ CSV', onclick: () => exportCSV(c, list, students) })),
            h('h3', { class: 'section-title', text: '依類別（匿名）' }),
            h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
                h('thead', {}, h('tr', {}, ['類別', '份數', '繳交率', '補交', '訂正完成率'].map(t => h('th', { text: t })))),
                h('tbody', {}, [...byType].map(([tid, t]) => h('tr', {}, h('td', { class: 'left', text: typeName(c, tid) }), h('td', { text: t.n }),
                    h('td', { text: ratio(t.submitted, t.submitted + t.missing) }), h('td', { text: t.late }), h('td', { text: ratio(t.done, t.done + t.needs) })))))),
            h('h3', { class: 'section-title', text: '個人（僅限教師）' }),
            h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
                h('thead', {}, h('tr', {}, ['座號', '姓名', '目前未交', '補交次數', '待訂正', '已訂正'].map(t => h('th', { text: t })))),
                h('tbody', {}, perStudent.map(r => h('tr', {}, h('td', { text: r.s.seat ?? '' }), h('td', { class: 'left', text: r.s.name }),
                    h('td', { text: r.missing }), h('td', { text: r.late }), h('td', { text: r.needs }), h('td', { text: r.done })))))),
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', text: '關閉', onclick: () => statsModal.close() })));
        statsModal.open();
    };
    const exportCSV = (c, list, students) => {
        const rows = [['指派日期', '期限', '類別', '範圍', '座號', '姓名', '繳交', '交件日', '補交', '訂正', '訂正完成時間']];
        for (const a of list) for (const s of students) {
            const r = getRecord(records, a.id, s.id);
            rows.push([a.assignedDate, a.dueDate || '', typeName(c, a.typeId), a.title, s.seat ?? '', s.name, SUBMISSION[r.submission], r.submittedDate || '', r.late ? '是' : '',
                r.correction ? CORRECTION[r.correction] : '', r.correctedAt ? `${app.localDate(r.correctedAt)} ${app.localTime(r.correctedAt)}` : '']);
        }
        app.downloadCSV(`${c.name}_作業紀錄_${app.stampForFile()}.csv`, rows);
    };

    // ---------------------------------------------------------------- settings (types + reward rule)
    const settingsModal = makeModal('hw-settings-modal', { label: '作業設定' });
    const openSettings = (c) => {
        const used = (tid) => assignmentsOf(c).filter(a => a.typeId === tid).length;
        const rows = c.hwTypes.map(t => h('div', { class: 'label-row hw-type-row', dataset: { tid: t.id } },
            h('input', { type: 'text', value: t.name, maxlength: '10', 'aria-label': '類別名稱', class: 'hwt-name' }),
            h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', class: 'hwt-active', checked: t.active ? true : null }), ' 使用中'),
            h('span', { class: 'muted', text: t.builtin ? '預設' : (used(t.id) ? `${used(t.id)} 份` : '自訂') }),
            !t.builtin && !used(t.id) ? h('button', { class: 'btn btn-secondary', text: '✕', title: '刪除這個類別', onclick: (e) => { e.currentTarget.parentElement.dataset.delete = '1'; e.currentTarget.parentElement.hidden = true; } }) : null));
        const newName = h('input', { type: 'text', id: 'hwt-new', maxlength: '10', placeholder: '新類別名稱' });
        const rewardOn = h('input', { type: 'checkbox', id: 'hw-reward-on', checked: c.hwReward?.enabled ? true : null });
        const rewardXp = h('input', { type: 'number', id: 'hw-reward-xp', min: '1', max: '50', value: c.hwReward?.xp ?? 5, style: 'max-width:5em' });
        fill(settingsModal.card, 
            h('h2', { text: '⚙️ 作業設定' }),
            h('h3', { class: 'hw-sec', text: '📚 作業類別' }),
            h('p', { class: 'modal-sub', text: '預設類別不能刪除，可以停用；已有作業的類別只能停用，歷史紀錄會保留。' }),
            h('div', { id: 'hwt-rows' }, rows),
            h('div', { class: 'label-row' }, newName, h('button', { class: 'btn btn-secondary', text: '＋ 新增類別', onclick: () => {
                try { const t = addHwType(c, newName.value, `hwt-${app.uid()}`); c.hwTypes = c.hwTypes.filter(x => x.id !== t.id); pendingAdds.push(t);
                    settingsModal.card.querySelector('#hwt-rows').append(h('div', { class: 'label-row hw-type-row', dataset: { tid: t.id, isNew: '1' } },
                        h('input', { type: 'text', value: t.name, maxlength: '10', class: 'hwt-name', 'aria-label': '類別名稱' }),
                        h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', class: 'hwt-active', checked: true }), ' 使用中'),
                        h('span', { class: 'muted', text: '新增' })));
                    newName.value = '';
                } catch (err) { alert(err.message); }
            } })),
            h('h3', { class: 'hw-sec', text: '🎉 正向獎勵（預設關閉）' }),
            h('p', { class: 'modal-sub', text: '作業預設不影響個人分數或 XP。開啟後，某份作業「應交的同學全部交齊」時，老師可以按按鈕頒發全班 XP（不會因個別同學未交而扣分）。' }),
            h('label', { class: 'inline-check' }, rewardOn, ' 開啟「全班交齊」獎勵，每份作業全班 XP +', rewardXp),
            h('div', { class: 'modal-actions' },
                h('button', { class: 'btn btn-secondary', text: '取消', onclick: () => settingsModal.close() }),
                h('button', { class: 'btn btn-primary', id: 'hw-settings-ok', text: '儲存', onclick: async () => {
                    try {
                        const next = { ...c, hwTypes: c.hwTypes.map(t => ({ ...t })) };
                        pendingAdds.forEach(t => next.hwTypes.push({ ...t }));
                        for (const row of settingsModal.card.querySelectorAll('.hw-type-row')) {
                            const tid = row.dataset.tid;
                            if (row.dataset.delete) {
                                const ok = canDeleteHwType(next, tid, assignmentsOf(c));
                                if (!ok.ok) throw new Error(ok.why);
                                next.hwTypes = next.hwTypes.filter(t => t.id !== tid); continue;
                            }
                            renameHwType(next, tid, row.querySelector('.hwt-name').value);
                            setHwTypeActive(next, tid, row.querySelector('.hwt-active').checked);
                        }
                        const xp = parseInt(rewardXp.value, 10);
                        if (rewardOn.checked && !(xp >= 1 && xp <= 50)) throw new Error('獎勵 XP 請輸入 1–50');
                        c.hwTypes = next.hwTypes; c.hwReward = { enabled: rewardOn.checked, xp: xp >= 1 ? xp : 5 };
                        pendingAdds.length = 0;
                        await app.saveClass(c);
                        settingsModal.close(); render(c); app.notify('作業設定已儲存');
                    } catch (err) { alert(err.message); }
                } })));
        pendingAdds.length = 0;
        settingsModal.open();
    };
    const pendingAdds = [];

    return {
        render,
        /** 離開分頁或切換班級：回到投影安全模式 */
        reset: () => { teacherView = false; selected.clear(); showArchived = false; },
        setDate: (d) => { date = d; },
    };
};
