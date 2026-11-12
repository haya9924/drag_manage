import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * public/app.js はブラウザ用の非モジュールスクリプト。最後の init() だけを外して
 * VM 上で読み込み、DOM に依存しない判定関数や通知ポーリングを検証する。
 */
function loadApp() {
    const file = join(import.meta.dirname, '..', 'public', 'app.js');
    const source = readFileSync(file, 'utf8');
    const withoutInit = source.replace(/\ninit\(\);\s*$/, '\n');
    assert.notEqual(withoutInit, source, 'app.js の末尾に init(); が見つかりません');
    const context = createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
    runInContext(withoutInit, context);
    return context;
}

test('UI は時刻別に異なる曜日・数量・期間の予定を単純フォームで編集可能とみなさない', () => {
    const context = loadApp();
    runInContext("state.data = { today: '2026-05-01' };", context);

    const analyze = (scheduleOverrides: Record<string, unknown>) =>
        runInContext(
            `scheduleRepresentation({
                dose_quantity: 1,
                schedules: [Object.assign({
                    enabled: true,
                    time: '08:00',
                    days: '1111111',
                    quantity: 1,
                    start_date: '2026-04-01',
                    end_date: null
                }, ${JSON.stringify(scheduleOverrides)})]
            })`,
            context,
        ) as { editable: boolean; reason: string };

    assert.equal(analyze({}).editable, true);
    assert.equal(analyze({ days: '1111100', quantity: 2 }).editable, false);
    assert.match(analyze({ days: '1111100', quantity: 2 }).reason, /曜日|1回量/);
    assert.equal(analyze({ end_date: '2026-12-31' }).editable, false);
    assert.match(analyze({ end_date: '2026-12-31' }).reason, /終了日/);
    assert.equal(analyze({ start_date: '2026-06-01' }).editable, false);
    assert.match(analyze({ start_date: '2026-06-01' }).reason, /開始日/);
});

test('UI 通知は権限未許可時に claim せず、非表示タブでもポーリングする', async () => {
    const context = loadApp();
    runInContext(
        `
        const requestPaths = [];
        const toasts = [];
        const shownNotifications = [];
        function FakeNotification(title, options) {
            shownNotifications.push({ title, options });
            this.close = () => {};
        }
        FakeNotification.permission = 'default';
        const fakeWindow = { focus: () => {}, Notification: FakeNotification };
        window = fakeWindow;
        Notification = FakeNotification;
        document = { visibilityState: 'hidden' };
        api = async (path) => {
            requestPaths.push(path);
            return { notifications: [{ event_id: 1, message: 'm1' }] };
        };
        toast = (message) => { toasts.push(message); };
        `,
        context,
    );

    await runInContext('pollNotifications()', context);
    let snapshot = runInContext('({ requestPaths, toasts, shownNotifications })', context) as any;
    assert.deepEqual([...snapshot.requestPaths], ['/api/notifications/due?channel=web&claim=0']);
    assert.deepEqual([...snapshot.toasts], []);
    assert.equal(snapshot.shownNotifications.length, 0);

    // 可視タブでも権限がなければトーストのみ。既読化はしない。
    runInContext(
        `document.visibilityState = 'visible';
         api = async (path) => {
             requestPaths.push(path);
             return { notifications: [{ event_id: 2, message: 'm2' }] };
         };`,
        context,
    );
    await runInContext('pollNotifications()', context);
    snapshot = runInContext('({ requestPaths, toasts, shownNotifications })', context) as any;
    assert.equal(snapshot.requestPaths.at(-1), '/api/notifications/due?channel=web&claim=0');
    assert.deepEqual([...snapshot.toasts], ['m2']);
    assert.equal(snapshot.shownNotifications.length, 0);

    // 非表示タブでも、権限があれば claim してブラウザ通知を出す。
    runInContext(
        `FakeNotification.permission = 'granted';
         document.visibilityState = 'hidden';
         api = async (path) => {
             requestPaths.push(path);
             return { notifications: [{ event_id: 3, message: 'm3' }] };
         };`,
        context,
    );
    await runInContext('pollNotifications()', context);
    snapshot = runInContext('({ requestPaths, toasts, shownNotifications })', context) as any;
    assert.equal(snapshot.requestPaths.at(-1), '/api/notifications/due?channel=web&claim=1');
    assert.deepEqual([...snapshot.toasts], ['m2']);
    assert.equal(snapshot.shownNotifications.length, 1);
    assert.equal(snapshot.shownNotifications[0].title, '服薬時間です');
    assert.equal(snapshot.shownNotifications[0].options.body, 'm3');
});

test('UI は表現不能な既存予定を置換せず、予定を送らない保存ではメタデータだけ更新する', async () => {
    const context = loadApp();
    runInContext(
        `
        const calls = [];
        const elements = {
            '#med-error': { hidden: true, textContent: '' },
            '#med-id': { value: 'm1' },
            '#med-name': { value: '複雑な予定' },
            '#med-dose': { value: '3' },
            '#med-unit': { value: '錠' },
            '#med-times': { value: '08:00, 20:00', disabled: false },
            '#med-low': { value: '7' },
            '#med-color': { value: '#0f766e' },
            '#med-notify': { checked: true },
            '#med-note': { value: '' },
            '#med-schedule-edit': {
                checked: true,
                disabled: true,
                dataset: { editable: '0', reason: '曜日が時刻ごとに異なります' }
            },
            '#med-dialog': { close: () => {} }
        };
        const weekdayInputs = ['0', '1', '2', '3', '4', '5', '6'].map((value) => ({
            value,
            checked: true,
            disabled: false
        }));
        document = {
            querySelector: (selector) => elements[selector],
            querySelectorAll: (selector) => (selector === '#weekdays input' ? weekdayInputs : [])
        };
        state.data = {
            today: '2026-05-01',
            medications: [{
                id: 'm1',
                name: '複雑な予定',
                dose_quantity: 1,
                unit: '錠',
                note: null,
                color: '#0f766e',
                low_stock_days: 7,
                notify: true,
                schedules: [
                    { enabled: true, time: '08:00', days: '1111100', quantity: 1, start_date: '2026-04-01', end_date: null },
                    { enabled: true, time: '20:00', days: '0000011', quantity: 2, start_date: '2026-04-01', end_date: null }
                ]
            }]
        };
        api = async (path, options) => { calls.push({ path, options }); return {}; };
        toast = () => {};
        refresh = async () => {};
        `,
        context,
    );

    // 表現不能な予定を「更新する」状態で保存しようとすると拒否する。
    await runInContext('submitMedForm({ preventDefault() {} })', context);
    let result = runInContext('({ calls, error: elements["#med-error"] })', context) as any;
    assert.equal(result.calls.length, 0);
    assert.equal(result.error.hidden, false);
    assert.match(result.error.textContent, /服薬予定を保存できません/);

    // チェックを外した保存は予定を送らず、メタデータだけ更新する。
    runInContext(
        `elements['#med-schedule-edit'].checked = false;
         elements['#med-error'].hidden = true;
         calls.length = 0;`,
        context,
    );
    await runInContext('submitMedForm({ preventDefault() {} })', context);
    result = runInContext('({ calls, error: elements["#med-error"] })', context) as any;
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].path, '/api/medications/m1');
    assert.equal(result.calls[0].options.method, 'PATCH');
    assert.equal(result.calls[0].options.body.dose_quantity, 3);
    assert.equal('schedules' in result.calls[0].options.body, false);
});
