'use strict';

/* 服薬管理 SPA。外部ライブラリなし。 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
const STATUS_LABELS = {
    taken: '服用済み',
    skipped: 'スキップ',
    due: '服薬時間',
    missed: '飲み忘れ',
    upcoming: '予定',
};

const state = {
    tab: 'today',
    data: null,
    history: null,
    loading: false,
};

// ------------------------------------------------------------ helpers

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function formatQuantity(n) {
    return String(Math.round(Number(n) * 100) / 100);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function localDateString(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateLabel(dateString) {
    const [y, m, d] = dateString.split('-').map(Number);
    const wd = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
    let label = `${m}/${d}（${wd}）`;
    if (state.data) {
        if (dateString === state.data.today) label += ' ・ 今日';
        const yesterday = addDays(state.data.today, -1);
        if (dateString === yesterday) label += ' ・ 昨日';
    }
    return label;
}

function addDays(dateString, days) {
    const d = new Date(`${dateString}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function timeOf(localDateTime) {
    return localDateTime.slice(11, 16);
}

function dateOf(localDateTime) {
    return localDateTime.slice(0, 10);
}

function safeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#0f766e';
}

function statusBadge(status) {
    return `<span class="badge badge-${status}">${STATUS_LABELS[status] ?? status}</span>`;
}

function relativeTime(minutes) {
    if (minutes === 0) return 'いま';
    const abs = Math.abs(minutes);
    const suffix = minutes < 0 ? '前' : '後';
    if (abs < 60) return `${abs}分${suffix}`;
    if (abs < 1440) return `${Math.floor(abs / 60)}時間${suffix}`;
    return `${Math.floor(abs / 1440)}日${suffix}`;
}

async function api(path, options = {}) {
    const init = { method: options.method ?? 'GET', headers: {} };
    if (options.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, init);
    let payload = null;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }
    if (!res.ok) {
        throw new Error(payload && payload.error ? payload.error : `通信に失敗しました (${res.status})`);
    }
    return payload;
}

let toastSeq = 0;

function toast(message, kind = '') {
    const region = $('#toast-region');
    const el = document.createElement('div');
    el.className = `toast ${kind}`.trim();
    el.textContent = message;
    el.dataset.seq = String(++toastSeq);
    region.prepend(el);
    while (region.children.length > 3) region.lastElementChild.remove();
    window.setTimeout(() => {
        el.style.transition = 'opacity .25s ease, transform .25s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        window.setTimeout(() => el.remove(), 280);
    }, kind === 'reminder' ? 9000 : 4800);
}

// ------------------------------------------------------------ header / stats

function renderHeader() {
    const data = state.data;
    if (!data) return;
    const [y, m, d] = data.today.split('-').map(Number);
    const wd = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
    const count = data.medications.length;
    $('#today-label').textContent = `${y}年${m}月${d}日（${wd}） ・ ${count}種類のお薬`;
}

function renderStats() {
    const data = state.data;
    if (!data) return;
    const c = data.counts;
    const next =
        data.doses.find((dose) => dose.display_status === 'due') ??
        data.doses.find((dose) => dose.display_status === 'upcoming') ??
        null;
    const lowCount = data.medications.filter((med) => med.low_stock).length;

    const cards = [
        {
            label: '今日の服薬',
            value: `${c.done}`,
            unit: `/ ${c.total}回`,
            cls: 'brand',
        },
        {
            label: '飲み忘れ',
            value: `${c.missed}`,
            unit: '回',
            cls: c.missed > 0 ? 'warn' : '',
        },
        {
            label: '在庫アラート',
            value: `${lowCount}`,
            unit: '件',
            cls: lowCount > 0 ? 'warn' : '',
        },
        {
            label: '次の服薬',
            value: next ? timeOf(next.scheduled_for) : '—',
            unit: next ? next.medication_name : '予定なし',
            cls: '',
        },
    ];

    $('#today-stats').innerHTML = cards
        .map(
            (card) => `
            <div class="stat ${card.cls}">
                <span class="stat-label">${esc(card.label)}</span>
                <span class="stat-value">${esc(card.value)}<small>${esc(card.unit)}</small></span>
            </div>`,
        )
        .join('');
}

function renderAlerts() {
    const data = state.data;
    if (!data) return;
    const alerts = data.medications
        .filter((med) => med.low_stock)
        .map((med) => {
            if (med.days_left === null || med.days_left <= 0) {
                return `${med.name} の在庫がありません`;
            }
            return `${med.name} の残りは約${med.days_left}日分です`;
        });
    $('#alerts').innerHTML = alerts.map((text) => `<div class="alert">${esc(text)}</div>`).join('');
}

// ------------------------------------------------------------ today

function doseRow(dose, opts = {}) {
    const status = dose.display_status;
    const time = timeOf(dose.scheduled_for);
    const qty = formatQuantity(dose.quantity > 0 ? dose.quantity : dose.planned_quantity);
    const subParts = [`${qty}${dose.unit}`];
    if (dose.note) subParts.push(dose.note);
    if (status === 'taken' && dose.taken_at) subParts.push(`${timeOf(dose.taken_at)} に記録`);

    let actions = '';
    if (opts.actions !== false) {
        if (status === 'taken' || status === 'skipped') {
            actions = `<button class="ghost small" type="button" data-dose-action="undo" data-dose-id="${dose.id}">取消</button>`;
        } else {
            actions = `
                <button class="primary small" type="button" data-dose-action="take" data-dose-id="${dose.id}">服用</button>
                <button class="ghost small" type="button" data-dose-action="skip" data-dose-id="${dose.id}">スキップ</button>`;
        }
    }

    const rowClass = status === 'due' || status === 'missed' ? dose.display_status : status;
    const small = status === 'taken' || status === 'skipped' ? '' : relativeTime(dose.minutes_from_now);

    return `
        <article class="dose ${esc(rowClass)}">
            <div class="dose-time">${esc(time)}${small ? `<small>${esc(small)}</small>` : ''}</div>
            <div class="dose-main">
                <div class="dose-name">${esc(dose.medication_name)}</div>
                <div class="dose-sub">${esc(subParts.join(' ・ '))}</div>
            </div>
            <div class="dose-side">
                ${statusBadge(status)}
                ${actions ? `<div class="dose-actions">${actions}</div>` : ''}
            </div>
        </article>`;
}

function renderToday() {
    const data = state.data;
    if (!data) return;
    renderStats();
    renderAlerts();

    const doses = data.doses;
    $('#today-count').textContent = doses.length ? `${data.counts.done} / ${doses.length} 回` : '予定なし';
    $('#today-list').innerHTML = doses.length
        ? doses.map((dose) => doseRow(dose)).join('')
        : '<div class="empty">今日の服薬予定はありません。<br>お薬タブから追加できます。</div>';

    const meds = data.medications;
    if (meds.length === 0) {
        $('#today-extra').innerHTML = '';
        return;
    }
    $('#today-extra').innerHTML = `
        <span class="today-extra-label">頓服・臨時の服薬:</span>
        ${meds
            .map(
                (med) =>
                    `<button class="ghost small" type="button" data-extra-med="${esc(med.id)}">＋ ${esc(med.name)}</button>`,
            )
            .join('')}`;
}

async function performDoseAction(id, action) {
    const labels = { take: '服用を記録しました', skip: 'スキップしました', undo: '記録を取り消しました' };
    try {
        const body = action === 'undo' ? undefined : {};
        await api(`/api/doses/${id}/${action}`, { method: 'POST', body });
        toast(labels[action] ?? '更新しました');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ------------------------------------------------------------ medications

function renderMeds() {
    const data = state.data;
    if (!data) return;
    const meds = data.medications;
    if (meds.length === 0) {
        $('#med-list').innerHTML =
            '<div class="empty">まだお薬が登録されていません。<br>「＋ お薬を追加」から登録してください。</div>';
        return;
    }

    $('#med-list').innerHTML = meds
        .map((med) => {
            const unit = esc(med.unit);
            const times = med.times.length ? med.times.join(' / ') : '頓服（時刻指定なし）';
            const low = med.low_stock;
            const target = med.daily_use > 0 ? med.daily_use * Math.max(med.low_stock_days, 1) : 0;
            const width = target > 0 ? Math.max(3, Math.min(100, (med.stock / target) * 100)) : med.stock > 0 ? 100 : 3;
            const daysText =
                med.days_left === null
                    ? '残日数: 予定なし'
                    : med.days_left <= 0
                      ? '残日数: 在庫なし'
                      : `あと約 <strong>${med.days_left}</strong> 日分`;
            const runOut = med.run_out_date
                ? `なくなる日 <strong>${esc(dateLabel(med.run_out_date).split(' ')[0])}</strong>`
                : '';

            return `
            <article class="med-card ${low ? 'low' : ''}" style="--med-color:${safeColor(med.color)}">
                <div class="med-top">
                    <div class="med-title-wrap">
                        <h3 class="med-name">${esc(med.name)} ${low ? '<span class="badge badge-missed">残りわずか</span>' : ''}</h3>
                        <p class="med-sub">
                            1回 ${esc(formatQuantity(med.dose_quantity))}${unit}
                            <span class="dot">・</span>${esc(times)}
                        </p>
                    </div>
                    <span class="stock-pill">残り ${esc(formatQuantity(med.stock))}${unit}</span>
                </div>
                <div class="stock-bar" aria-hidden="true"><span style="width:${width}%"></span></div>
                <div class="med-meta">
                    <span>${daysText}</span>
                    ${runOut ? `<span>${runOut}</span>` : ''}
                    <span>アラート ${esc(med.low_stock_days)} 日分</span>
                </div>
                <div class="med-actions">
                    <button class="primary small" type="button" data-med-action="take" data-med-id="${esc(med.id)}">今飲んだ</button>
                    <button class="ghost small" type="button" data-med-action="purchase" data-med-id="${esc(med.id)}">購入追加</button>
                    <button class="ghost small" type="button" data-med-action="adjust" data-med-id="${esc(med.id)}">残数修正</button>
                    <button class="ghost small" type="button" data-med-action="edit" data-med-id="${esc(med.id)}">編集</button>
                </div>
            </article>`;
        })
        .join('');
}

function findMedication(id) {
    return state.data ? state.data.medications.find((med) => med.id === id) : null;
}

function openMedDialog(med = null) {
    const form = $('#med-form');
    form.reset();
    $('#med-error').hidden = true;
    $('#med-id').value = med ? med.id : '';
    $('#med-title').textContent = med ? 'お薬を編集' : 'お薬を追加';
    $('#med-deactivate').classList.toggle('hidden', !med);

    const scheduleEdit = $('#med-schedule-edit');
    const scheduleEditRow = $('#med-schedule-edit-row');
    const scheduleNote = $('#med-schedule-note');

    if (med) {
        $('#med-name').value = med.name;
        $('#med-dose').value = formatQuantity(med.dose_quantity);
        $('#med-unit').value = med.unit;
        $('#med-times').value = med.times.join(', ');
        $('#med-low').value = String(med.low_stock_days);
        $('#med-color').value = safeColor(med.color);
        $('#med-notify').checked = Boolean(med.notify);
        $('#med-note').value = med.note ?? '';

        const representation = scheduleRepresentation(med);
        const schedule = med.schedules.find((s) => s.enabled);
        const mask = schedule ? schedule.days : representation.days;
        $$('#weekdays input').forEach((input) => {
            input.checked = mask[Number(input.value)] === '1';
        });

        // 既存の予定は、ユーザーが明示的にチェックしたときだけ置き換える。
        scheduleEditRow.classList.remove('hidden');
        scheduleNote.classList.remove('hidden');
        scheduleEdit.checked = false;
        scheduleEdit.disabled = !representation.editable;
        scheduleEdit.dataset.editable = representation.editable ? '1' : '0';
        scheduleEdit.dataset.reason = representation.reason;
    } else {
        $('#med-times').value = '08:00';
        $$('#weekdays input').forEach((input) => {
            input.checked = true;
        });
        scheduleEditRow.classList.add('hidden');
        scheduleNote.classList.add('hidden');
        scheduleEdit.checked = true;
        scheduleEdit.disabled = false;
        scheduleEdit.dataset.editable = '1';
        scheduleEdit.dataset.reason = '';
    }

    updateScheduleEditor();
    $('#med-dialog').showModal();
    window.setTimeout(() => $('#med-name').focus(), 60);
}

/** この画面の単純なフォーム（全時刻で同じ曜日・同じ1回量・期間なし）で表せるか。 */
function scheduleRepresentation(med) {
    const enabled = (med.schedules || []).filter((schedule) => schedule.enabled);
    if (enabled.length === 0) return { editable: true, days: '1111111', reason: '' };

    const days = enabled[0].days;
    const today = state.data ? state.data.today : localDateString();
    for (const schedule of enabled) {
        if (schedule.days !== days) {
            return { editable: false, days, reason: '曜日が時刻ごとに異なります' };
        }
        if (Number(schedule.quantity) !== Number(med.dose_quantity)) {
            return { editable: false, days, reason: '1回量が時刻ごとに異なります' };
        }
        if (schedule.end_date) {
            return { editable: false, days, reason: '終了日が設定されています' };
        }
        if (schedule.start_date && schedule.start_date > today) {
            return { editable: false, days, reason: '開始日が未来に設定されています' };
        }
    }
    return { editable: true, days, reason: '' };
}

function setScheduleEditorEnabled(enabled) {
    $('#med-times').disabled = !enabled;
    $$('#weekdays input').forEach((input) => {
        input.disabled = !enabled;
    });
}

function updateScheduleEditor() {
    const checkbox = $('#med-schedule-edit');
    const canEdit = checkbox.dataset.editable !== '0';
    const enabled = canEdit && checkbox.checked;
    setScheduleEditorEnabled(enabled);

    const note = $('#med-schedule-note');
    if (!canEdit) {
        note.textContent = `この薬の予定は${checkbox.dataset.reason}。この画面では予定を変更できません（名前・在庫設定などは保存できます）。予定を変える場合は API を使用してください。`;
    } else if (enabled) {
        note.textContent = '保存すると、この薬の未来の未服薬予定を時刻・曜日・1回量で置き換えます。過去の記録は変わりません。';
    } else {
        note.textContent = '予定を変更する場合はチェックを入れてください。チェックしない場合、時刻・曜日・予定の1回量は変更しません。';
    }
}

function parseTimes(raw) {
    const parts = raw
        .split(/[,、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const seen = new Set();
    for (const part of parts) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(part)) {
            throw new Error(`「${part}」は HH:MM 形式で入力してください`);
        }
        if (seen.has(part)) throw new Error(`時刻 ${part} が重複しています`);
        seen.add(part);
    }
    return parts.sort();
}

function weekdayMask() {
    return $$('#weekdays input')
        .map((input) => (input.checked ? '1' : '0'))
        .join('');
}

async function submitMedForm(event) {
    event.preventDefault();
    const errorEl = $('#med-error');
    errorEl.hidden = true;
    const id = $('#med-id').value;

    try {
        const name = $('#med-name').value.trim();
        if (!name) throw new Error('お薬の名前を入力してください');
        const dose = Number($('#med-dose').value);
        if (!Number.isFinite(dose) || dose <= 0) throw new Error('1回量は0より大きい数値で入力してください');
        const lowDays = Number($('#med-low').value);
        if (!Number.isInteger(lowDays) || lowDays < 0) throw new Error('残数アラートは0以上の整数で入力してください');

        const times = $('#med-times').value;
        const editSchedule = !id || $('#med-schedule-edit').checked;
        let schedules = null;
        if (editSchedule) {
            const parsedTimes = parseTimes(times);
            const days = weekdayMask();
            if (parsedTimes.length > 0 && !days.includes('1')) {
                throw new Error('服薬する曜日を1つ以上選んでください（時刻を空欄にすると頓服になります）');
            }
            if (id) {
                const med = findMedication(id);
                const representation = scheduleRepresentation(med);
                if (!representation.editable) {
                    throw new Error(
                        `服薬予定を保存できません（${representation.reason}）。この画面では安全に表現できないため、チェックを外して名前・在庫設定だけを保存してください。予定を変える場合は API を使用してください。`,
                    );
                }
            }
            schedules = parsedTimes.map((time) => ({ time, days, quantity: dose }));
        }

        const payload = {
            name,
            dose_quantity: dose,
            unit: $('#med-unit').value.trim() || '錠',
            note: $('#med-note').value.trim() || null,
            color: $('#med-color').value,
            low_stock_days: lowDays,
            notify: $('#med-notify').checked,
        };
        if (schedules) payload.schedules = schedules;

        if (id) {
            await api(`/api/medications/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
        } else {
            await api('/api/medications', { method: 'POST', body: payload });
        }
        $('#med-dialog').close();
        toast(id ? 'お薬を更新しました' : 'お薬を登録しました');
        await refresh();
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
    }
}

async function deactivateMedication() {
    const id = $('#med-id').value;
    if (!id) return;
    if (!window.confirm('このお薬の服用予定を停止しますか？\n服用履歴と在庫は残ります。')) return;
    try {
        await api(`/api/medications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        $('#med-dialog').close();
        toast('服用予定を停止しました');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function openPurchaseDialog(med) {
    $('#purchase-form').reset();
    $('#purchase-med-id').value = med.id;
    $('#purchase-med-name').textContent = `${med.name}（残り ${formatQuantity(med.stock)}${med.unit}）`;
    $('#purchase-date').value = localDateString();
    $('#purchase-dialog').showModal();
    window.setTimeout(() => $('#purchase-qty').focus(), 60);
}

async function submitPurchase(event) {
    event.preventDefault();
    const id = $('#purchase-med-id').value;
    try {
        const quantity = Number($('#purchase-qty').value);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('購入数は0より大きい数値で入力してください');
        const body = {
            quantity,
            purchased_at: $('#purchase-date').value || localDateString(),
            note: $('#purchase-note').value.trim() || null,
        };
        const price = $('#purchase-price').value;
        if (price !== '') body.price = Number(price);

        await api(`/api/medications/${encodeURIComponent(id)}/purchases`, { method: 'POST', body });
        $('#purchase-dialog').close();
        toast('購入を追加しました');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function openAdjustDialog(med) {
    $('#adjust-form').reset();
    $('#adjust-med-id').value = med.id;
    $('#adjust-med-name').textContent = med.name;
    $('#adjust-stock').textContent = `${formatQuantity(med.stock)}${med.unit}`;
    $('#adjust-dialog').showModal();
    window.setTimeout(() => $('#adjust-delta').focus(), 60);
}

async function submitAdjust(event) {
    event.preventDefault();
    const id = $('#adjust-med-id').value;
    try {
        const delta = Number($('#adjust-delta').value);
        if (!Number.isFinite(delta) || delta === 0) throw new Error('増減は0以外の数値で入力してください');
        await api(`/api/medications/${encodeURIComponent(id)}/adjustments`, {
            method: 'POST',
            body: { delta, reason: $('#adjust-reason').value.trim() || null },
        });
        $('#adjust-dialog').close();
        toast('残数を修正しました');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function recordManualDose(med) {
    const label = `${med.name} を ${formatQuantity(med.dose_quantity)}${med.unit}、今飲んだ記録にしますか？`;
    if (!window.confirm(label)) return;
    try {
        await api('/api/doses', {
            method: 'POST',
            body: { medication_id: med.id, quantity: med.dose_quantity, note: '頓服・臨時' },
        });
        toast('服薬を記録しました');
        await refresh();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ------------------------------------------------------------ history

async function loadHistory() {
    const days = Number($('#history-days').value || 30);
    try {
        state.history = await api(`/api/history?days=${days}`);
        renderHistory();
    } catch (err) {
        toast(err.message, 'error');
    }
}

function renderHistory() {
    const history = state.history;
    if (!history) {
        $('#history-list').innerHTML = '<div class="empty">読み込み中…</div>';
        return;
    }

    const groups = new Map();
    for (const dose of history.doses) {
        const key = dateOf(dose.scheduled_for);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(dose);
    }
    const dates = Array.from(groups.keys()).sort().reverse();

    if (dates.length === 0) {
        $('#history-list').innerHTML = '<div class="empty">この期間の服薬履歴はありません。</div>';
    } else {
        $('#history-list').innerHTML = dates
            .map((date) => {
                const rows = groups
                    .get(date)
                    .slice()
                    .sort((a, b) => (a.scheduled_for < b.scheduled_for ? 1 : -1))
                    .map((dose) => doseRow(dose))
                    .join('');
                return `<div class="date-head">${esc(dateLabel(date))}</div>${rows}`;
            })
            .join('');
    }

    if (history.purchases.length === 0) {
        $('#purchase-list').innerHTML = '<div class="empty">この期間の購入履歴はありません。</div>';
    } else {
        $('#purchase-list').innerHTML = history.purchases
            .map((p) => {
                const price = p.price === null || p.price === undefined ? '' : ` ・ ¥${Number(p.price).toLocaleString('ja-JP')}`;
                return `
                <div class="plain-row">
                    <span class="left">${esc(dateLabel(p.purchased_at).split(' ')[0])} ${esc(p.medication_name)}${esc(p.note ? `（${p.note}）` : '')}${esc(price)}</span>
                    <span class="right amount-plus">+${esc(formatQuantity(p.quantity))}${esc(p.unit)}</span>
                </div>`;
            })
            .join('');
    }

    if (history.adjustments.length === 0) {
        $('#adjustment-list').innerHTML = '<div class="empty">この期間の残数修正はありません。</div>';
    } else {
        $('#adjustment-list').innerHTML = history.adjustments
            .map((a) => {
                const positive = Number(a.delta) > 0;
                return `
                <div class="plain-row">
                    <span class="left">${esc(dateLabel(dateOf(a.created_at)).split(' ')[0])} ${esc(a.medication_name)}${esc(a.reason ? `（${a.reason}）` : '')}</span>
                    <span class="right ${positive ? 'amount-plus' : 'amount-minus'}">${positive ? '+' : ''}${esc(formatQuantity(a.delta))}${esc(a.unit)}</span>
                </div>`;
            })
            .join('');
    }
}

// ------------------------------------------------------------ tabs

function switchTab(tab) {
    state.tab = tab;
    $$('.view').forEach((view) => view.classList.add('hidden'));
    const view = $(`#view-${tab}`);
    if (view) view.classList.remove('hidden');
    $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    if (tab === 'history') loadHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------ notifications

let polling = false;
const toastedEvents = new Set();
const notifiedEvents = new Set();

function notificationPermissionGranted() {
    return 'Notification' in window && Notification.permission === 'granted';
}

function updateNotifyButton() {
    const button = $('#notify-btn');
    if (!('Notification' in window)) {
        button.textContent = '通知非対応';
        button.disabled = true;
        return;
    }
    if (Notification.permission === 'granted') {
        button.textContent = '通知オン';
    } else if (Notification.permission === 'denied') {
        button.textContent = '通知ブロック中';
    } else {
        button.textContent = '通知を有効に';
    }
}

async function enableNotifications() {
    if (!('Notification' in window)) {
        toast('このブラウザは通知に対応していません', 'error');
        return;
    }
    if (Notification.permission === 'denied') {
        toast('ブラウザの設定で通知がブロックされています', 'error');
        return;
    }
    const permission = await Notification.requestPermission();
    updateNotifyButton();
    if (permission === 'granted') {
        toast('ブラウザ通知を有効にしました');
        await pollNotifications();
    } else {
        toast('通知は許可されませんでした', 'error');
    }
}

async function pollNotifications() {
    // 非表示タブでも動かす。表示中だけにすると、別タブを見ている間の通知を取りこぼす。
    if (polling) return;
    polling = true;
    try {
        const granted = notificationPermissionGranted();
        // 通知権限がない状態では既読化しない。許可後に取りこぼさないよう候補を残す。
        const payload = await api(`/api/notifications/due?channel=web&claim=${granted ? '1' : '0'}`);
        for (const item of payload.notifications) {
            if (document.visibilityState === 'visible' && !toastedEvents.has(item.event_id)) {
                toast(item.message, 'reminder');
                toastedEvents.add(item.event_id);
            }
            if (granted && !notifiedEvents.has(item.event_id)) {
                notifiedEvents.add(item.event_id);
                try {
                    const note = new Notification('服薬時間です', {
                        body: item.message,
                        tag: `dose-${item.event_id}`,
                        requireInteraction: true,
                    });
                    note.onclick = () => {
                        window.focus();
                        note.close();
                    };
                } catch {
                    /* 通知できない環境ではトーストのみ */
                }
            }
        }
    } catch {
        /* 一時的な通信失敗は無視して次の周期に任せる */
    } finally {
        polling = false;
    }
}

// ------------------------------------------------------------ refresh

async function refresh(silent = false) {
    if (state.loading) return;
    state.loading = true;
    try {
        state.data = await api('/api/state');
        renderHeader();
        renderToday();
        renderMeds();
        if (state.tab === 'history') await loadHistory();
    } catch (err) {
        if (!silent) toast(err.message, 'error');
    } finally {
        state.loading = false;
    }
}

// ------------------------------------------------------------ bootstrap

function bindEvents() {
    $$('.tab').forEach((button) => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    $('#add-med-btn').addEventListener('click', () => openMedDialog());
    $('#med-form').addEventListener('submit', submitMedForm);
    $('#med-schedule-edit').addEventListener('change', updateScheduleEditor);
    $('#med-deactivate').addEventListener('click', deactivateMedication);
    $('#purchase-form').addEventListener('submit', submitPurchase);
    $('#adjust-form').addEventListener('submit', submitAdjust);
    $('#history-days').addEventListener('change', loadHistory);
    $('#notify-btn').addEventListener('click', enableNotifications);

    $('#today-list').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-dose-action]');
        if (!button) return;
        button.disabled = true;
        performDoseAction(Number(button.dataset.doseId), button.dataset.doseAction).finally(() => {
            button.disabled = false;
        });
    });

    $('#history-list').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-dose-action]');
        if (!button) return;
        button.disabled = true;
        performDoseAction(Number(button.dataset.doseId), button.dataset.doseAction).finally(() => {
            button.disabled = false;
        });
    });

    $('#today-extra').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-extra-med]');
        if (!button) return;
        const med = findMedication(button.dataset.extraMed);
        if (med) recordManualDose(med);
    });

    $('#med-list').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-med-action]');
        if (!button) return;
        const med = findMedication(button.dataset.medId);
        if (!med) return;
        const action = button.dataset.medAction;
        if (action === 'edit') openMedDialog(med);
        else if (action === 'purchase') openPurchaseDialog(med);
        else if (action === 'adjust') openAdjustDialog(med);
        else if (action === 'take') recordManualDose(med);
    });

    $$('[data-close]').forEach((button) => {
        button.addEventListener('click', () => button.closest('dialog').close());
    });

    $$('dialog.sheet').forEach((dialog) => {
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            refresh(true);
            pollNotifications();
        }
    });
}

async function init() {
    bindEvents();
    updateNotifyButton();
    await refresh();
    pollNotifications();
    window.setInterval(() => refresh(true), 60_000);
    window.setInterval(pollNotifications, 30_000);
}

init();
