import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';

const TOKEN = 'safety-test-token';
const NOW = Date.parse('2026-05-01T08:05:00+09:00'); // 金曜 08:05 JST

let base = '';
let server: ReturnType<typeof createServer>;
let app: ReturnType<typeof createApp>;
let dir = '';

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
    dir = mkdtempSync(join(tmpdir(), 'drag-manage-safety-'));
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

test('HERMES_TOKEN 未設定時は /api/agent/* を fail closed にする', async () => {
    const strict = createApp({
        dbPath: ':memory:',
        token: '',
        now: () => NOW,
        offsetMinutes: 540,
    });
    const strictServer = createServer((req, res) => {
        void strict.handler(req, res);
    });
    await new Promise<void>((resolve) => strictServer.listen(0, '127.0.0.1', resolve));
    const strictBase = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
    try {
        const health = await fetch(`${strictBase}/api/health`);
        assert.equal(health.status, 200);

        const denied = await fetch(`${strictBase}/api/agent/summary`);
        assert.equal(denied.status, 401);

        const evenWithBearer = await fetch(`${strictBase}/api/agent/summary`, {
            headers: { Authorization: 'Bearer ' },
        });
        assert.equal(evenWithBearer.status, 401);
    } finally {
        await new Promise<void>((resolve) => strictServer.close(() => resolve()));
        strict.store.close();
    }
});

test('薬の更新で時刻別の曜日・数量・期間を暗黙に変更しない', async () => {
    const created = await api('/api/medications', {
        method: 'POST',
        body: {
            name: '複雑な予定',
            dose_quantity: 1,
            unit: '錠',
            schedules: [
                { time: '08:00', days: '1111100', quantity: 1, start_date: '2026-04-01', end_date: '2026-12-31' },
                { time: '20:00', days: '0000011', quantity: 2, start_date: '2026-04-01' },
            ],
        },
    });
    assert.equal(created.status, 201);
    const id = created.body.medication.id as string;
    const pick = (schedules: any[]) =>
        schedules.map((s) => ({
            time: s.time,
            days: s.days,
            quantity: s.quantity,
            start_date: s.start_date,
            end_date: s.end_date,
            enabled: s.enabled,
        }));
    const beforeSchedules = pick(created.body.medication.schedules);

    const patched = await api(`/api/medications/${id}`, {
        method: 'PATCH',
        body: { name: '複雑な予定（改名）', dose_quantity: 3 },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.medication.dose_quantity, 3);
    assert.deepEqual(pick(patched.body.medication.schedules), beforeSchedules);

    // 未来の予定数量も、予定を送っていない PATCH では変わらない
    const future = await api('/api/doses?date=2026-05-02', { token: null });
    const saturday = future.body.doses.find(
        (d: any) => d.medication_id === id && d.scheduled_for === '2026-05-02T20:00',
    );
    assert.ok(saturday);
    assert.equal(saturday.planned_quantity, 2);
});

test('予定変更後に過去日へ新しい予定を生成しない', async () => {
    const created = await api('/api/medications', {
        method: 'POST',
        body: {
            name: '過去生成の検証',
            dose_quantity: 1,
            unit: '錠',
            schedules: [{ time: '20:00', days: '1111111', quantity: 1, start_date: '2026-04-01' }],
        },
    });
    assert.equal(created.status, 201);
    const id = created.body.medication.id as string;

    // 同じ時刻の曜日を月曜だけへ変更する。start_date は過去日のまま保持される。
    const updated = await api(`/api/medications/${id}/schedules`, {
        method: 'PUT',
        body: { times: ['20:00'], days: '1000000' },
    });
    assert.equal(updated.status, 200);

    // 2026-04-06 は月曜。旧実装はここで現在の設定を遡って生成していた。
    const past = await api('/api/doses?date=2026-04-06', { token: null });
    assert.equal(past.status, 200);
    assert.equal(past.body.doses.filter((d: any) => d.medication_id === id).length, 0);

    const pastState = await api('/api/state?date=2026-04-06', { token: null });
    assert.equal(pastState.status, 200);
    assert.equal(pastState.body.doses.filter((d: any) => d.medication_id === id).length, 0);

    // 未来の月曜（2026-05-04）には通常どおり生成される
    const future = await api('/api/doses?date=2026-05-04', { token: null });
    const futureDoses = future.body.doses.filter((d: any) => d.medication_id === id);
    assert.equal(futureDoses.length, 1);
    assert.equal(futureDoses[0].scheduled_for, '2026-05-04T20:00');

    // 履歴表示だけでも過去分を新規生成しない
    const history = await api('/api/history?days=60', { token: null });
    assert.equal(history.status, 200);
    assert.equal(
        history.body.doses.filter((d: any) => d.medication_id === id && d.scheduled_for < '2026-05-01T00:00').length,
        0,
    );
});
