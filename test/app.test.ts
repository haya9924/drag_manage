import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';

const TOKEN = 'test-hermes-token';
const NOW = Date.parse('2026-05-01T08:05:00+09:00'); // 金曜 08:05 JST

let base = '';
let server: ReturnType<typeof createServer>;
let app: ReturnType<typeof createApp>;
let dir = '';
let medicationId = '';
let morningId = 0;
let eveningId = 0;

async function api(path: string, options: { method?: string; body?: unknown; token?: string | null } = {}) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? TOKEN}`;
    const res = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = (await res.json()) as Record<string, any>;
    return { status: res.status, body };
}

before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'drag-manage-test-'));
    app = createApp({
        dbPath: join(dir, 'test.db'),
        token: TOKEN,
        now: () => NOW,
        offsetMinutes: 540,
        missAfterMinutes: 120,
        reminderWindowMinutes: 60,
    });
    server = createServer((req, res) => {
        void app.handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
});

test('健康チェックと認証', async () => {
    const health = await api('/api/health', { token: null });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const unauth = await api('/api/agent/summary', { token: null });
    assert.equal(unauth.status, 401);

    const bad = await api('/api/agent/summary', { token: 'wrong' });
    assert.equal(bad.status, 401);

    const auth = await api('/api/agent/summary');
    assert.equal(auth.status, 200);
});

test('薬の登録と当日の予定生成', async () => {
    const created = await api('/api/medications', {
        method: 'POST',
        body: {
            name: 'ロキソニン',
            dose_quantity: 1,
            unit: '錠',
            times: ['08:00', '20:00'],
            days: '1111111',
            low_stock_days: 7,
        },
    });
    assert.equal(created.status, 201);
    medicationId = created.body.medication.id;
    assert.deepEqual(created.body.medication.times, ['08:00', '20:00']);
    assert.equal(created.body.medication.stock, 0);

    const state = await api('/api/state', { token: null });
    assert.equal(state.status, 200);
    assert.equal(state.body.date, '2026-05-01');
    assert.equal(state.body.doses.length, 2);

    const morning = state.body.doses.find((d: any) => d.scheduled_for === '2026-05-01T08:00');
    const evening = state.body.doses.find((d: any) => d.scheduled_for === '2026-05-01T20:00');
    assert.ok(morning);
    assert.ok(evening);
    assert.equal(morning.display_status, 'due');
    assert.equal(evening.display_status, 'upcoming');
    assert.equal(state.body.counts.due, 1);
    morningId = morning.id;
    eveningId = evening.id;
});

test('通知はチャネルごとに一度だけ返る', async () => {
    const unauth = await api('/api/agent/notifications/due', { token: null });
    assert.equal(unauth.status, 401);

    const first = await api('/api/agent/notifications/due?claim=1');
    assert.equal(first.status, 200);
    assert.equal(first.body.notifications.length, 1);
    assert.equal(first.body.notifications[0].medication_name, 'ロキソニン');
    assert.match(first.body.notifications[0].message, /服薬時間です/);

    const second = await api('/api/agent/notifications/due?claim=1');
    assert.equal(second.body.notifications.length, 0);

    // web チャネルは Hermes とは独立
    const web = await api('/api/notifications/due?channel=web&claim=1', { token: null });
    assert.equal(web.body.notifications.length, 1);
    const webAgain = await api('/api/notifications/due?channel=web&claim=1', { token: null });
    assert.equal(webAgain.body.notifications.length, 0);

    // 5分前に過ぎた予定は lookback=1 では対象外
    const narrow = await api('/api/notifications/due?channel=test2&lookback=1&claim=1', { token: null });
    assert.equal(narrow.body.notifications.length, 0);
});

test('購入で在庫と残日数が増える', async () => {
    const bought = await api(`/api/medications/${medicationId}/purchases`, {
        method: 'POST',
        body: { quantity: 10, purchased_at: '2026-05-01', price: 500, note: '1箱' },
    });
    assert.equal(bought.status, 201);
    assert.equal(bought.body.medication.stock, 10);
    assert.equal(bought.body.medication.daily_use, 2);
    assert.equal(bought.body.medication.days_left, 5);
    assert.equal(bought.body.medication.run_out_date, '2026-05-06');
    assert.equal(bought.body.medication.low_stock, true);
});

test('服薬記録で在庫が減り、二重記録は冪等', async () => {
    const taken = await api(`/api/doses/${morningId}/take`, { method: 'POST', token: null });
    assert.equal(taken.status, 200);
    assert.equal(taken.body.dose.status, 'taken');
    assert.equal(taken.body.dose.quantity, 1);

    const again = await api(`/api/doses/${morningId}/take`, { method: 'POST', token: null });
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);

    const med = await api(`/api/medications/${medicationId}`, { token: null });
    assert.equal(med.body.medication.stock, 9);
    assert.equal(med.body.medication.consumed, 1);
});

test('スキップ・取り消し・エージェント経由の操作', async () => {
    const skipped = await api(`/api/doses/${eveningId}/skip`, { method: 'POST', token: null });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.dose.status, 'skipped');

    let med = await api(`/api/medications/${medicationId}`, { token: null });
    assert.equal(med.body.medication.stock, 9); // スキップは在庫を減らさない

    const undone = await api(`/api/doses/${eveningId}/undo`, { method: 'POST' }); // Hermes 経由
    assert.equal(undone.status, 200);
    assert.equal(undone.body.dose.status, 'pending');

    const takenByAgent = await api(`/api/agent/doses/${eveningId}/take`, { method: 'POST', body: {} });
    assert.equal(takenByAgent.status, 200);
    assert.equal(takenByAgent.body.dose.status, 'taken');

    med = await api(`/api/medications/${medicationId}`, { token: null });
    assert.equal(med.body.medication.stock, 8);
});

test('手動の服薬記録と在庫調整', async () => {
    const manual = await api('/api/doses', {
        method: 'POST',
        body: { medication_id: medicationId, quantity: 1, note: '頓服' },
    });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.dose.status, 'taken');
    assert.equal(manual.body.dose.source, 'manual');

    let med = await api(`/api/medications/${medicationId}`, { token: null });
    assert.equal(med.body.medication.stock, 7);

    const adjusted = await api(`/api/medications/${medicationId}/adjustments`, {
        method: 'POST',
        body: { delta: -2, reason: '棚卸し' },
    });
    assert.equal(adjusted.status, 201);
    assert.equal(adjusted.body.medication.stock, 5);
    assert.equal(adjusted.body.medication.adjusted, -2);
});

test('予定変更で未来の未服薬分だけ入れ替わる', async () => {
    const updated = await api(`/api/medications/${medicationId}/schedules`, {
        method: 'PUT',
        body: { times: ['09:30'], days: '1111111' },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.medication.times, ['09:30']);

    const state = await api('/api/state', { token: null });
    const times = state.body.doses.map((d: any) => d.scheduled_for);
    assert.ok(times.includes('2026-05-01T20:00')); // 服用済みの記録は残る
    assert.ok(times.includes('2026-05-01T09:30')); // 新しい予定

    // 未来日の 20:00 は未服薬なので新しい時刻だけになる
    const future = await api('/api/doses?date=2026-05-02', { token: null });
    assert.equal(future.body.doses.length, 1);
    assert.equal(future.body.doses[0].scheduled_for, '2026-05-02T09:30');
});

test('残日数アラートと履歴・サマリー', async () => {
    const patched = await api(`/api/medications/${medicationId}`, {
        method: 'PATCH',
        body: { low_stock_days: 30 },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.medication.low_stock, true);

    const low = await api('/api/agent/low-stock');
    assert.equal(low.status, 200);
    assert.equal(low.body.low_stock.length, 1);
    assert.match(low.body.alerts[0].message, /残りは約/);

    const summary = await api('/api/agent/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.medications.length, 1);
    assert.equal(summary.body.counts.taken, 3);
    assert.ok(summary.body.next_dose);

    const history = await api('/api/history?days=7', { token: null });
    assert.equal(history.status, 200);
    assert.equal(history.body.from, '2026-04-25');
    assert.equal(history.body.to, '2026-05-01');
    assert.ok(history.body.doses.length >= 3);
    assert.equal(history.body.purchases.length, 1);
    assert.equal(history.body.adjustments.length, 1);
});

test('入力バリデーション', async () => {
    const noName = await api('/api/medications', { method: 'POST', body: { times: ['08:00'] } });
    assert.equal(noName.status, 400);

    const dup = await api('/api/medications', {
        method: 'POST',
        body: { name: 'テスト', times: ['08:00', '08:00'] },
    });
    assert.equal(dup.status, 400);

    const badDays = await api('/api/medications', {
        method: 'POST',
        body: { name: 'テスト', times: ['08:00'], days: '1111' },
    });
    assert.equal(badDays.status, 400);

    const badQty = await api(`/api/medications/${medicationId}/purchases`, {
        method: 'POST',
        body: { quantity: 0 },
    });
    assert.equal(badQty.status, 400);

    const missing = await api('/api/doses/999999/take', { method: 'POST', token: null });
    assert.equal(missing.status, 404);

    const notFound = await api('/api/nope', { token: null });
    assert.equal(notFound.status, 404);
});
