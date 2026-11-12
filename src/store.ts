/**
 * SQLite ストア。スキーマ・服薬予定の生成・在庫計算・通知の既読管理を担当する。
 * node:sqlite の組み込みドライバのみを使う（外部依存なし）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.ts';
import {
    addDays,
    addMinutes,
    computeDailyUse,
    computeWeeklyUse,
    diffMinutes,
    formatQuantity,
    isScheduleActiveOn,
    localParts,
    round2,
} from './time.ts';

export type MedicationRow = {
    id: string;
    name: string;
    dose_quantity: number;
    unit: string;
    note: string | null;
    color: string | null;
    active: number;
    low_stock_days: number;
    notify: number;
    sort: number;
    created_at: string;
    updated_at: string;
};

export type ScheduleRow = {
    id: number;
    medication_id: string;
    time: string;
    days: string;
    quantity: number;
    start_date: string | null;
    end_date: string | null;
    enabled: number;
    created_at: string;
};

export type DoseEventRow = {
    id: number;
    medication_id: string;
    schedule_id: number | null;
    scheduled_for: string;
    planned_quantity: number;
    status: 'pending' | 'taken' | 'skipped';
    quantity: number;
    taken_at: string | null;
    note: string | null;
    source: string;
    created_at: string;
};

export type EventView = DoseEventRow & {
    medication_name: string;
    unit: string;
    color: string | null;
    medication_active: number;
    display_status: 'taken' | 'skipped' | 'due' | 'missed' | 'upcoming';
    minutes_from_now: number;
};

export type MedicationStats = MedicationRow & {
    active: boolean;
    notify: boolean;
    schedules: Array<Omit<ScheduleRow, 'enabled'> & { enabled: boolean }>;
    times: string[];
    purchased: number;
    consumed: number;
    adjusted: number;
    stock: number;
    daily_use: number;
    weekly_use: number;
    days_left: number | null;
    run_out_date: string | null;
    low_stock: boolean;
};

export type MedicationInput = {
    name: string;
    dose_quantity: number;
    unit: string;
    note: string | null;
    color: string | null;
    low_stock_days: number;
    notify: boolean;
    active: boolean;
};

export type ScheduleInput = {
    time: string;
    days: string;
    quantity: number;
    start_date: string | null;
    end_date: string | null;
    enabled: boolean;
};

export type StoreOptions = {
    dbPath: string;
    offsetMinutes?: number;
    now?: () => number;
    missAfterMinutes?: number;
    reminderWindowMinutes?: number;
};

type Counts = {
    total: number;
    taken: number;
    skipped: number;
    due: number;
    missed: number;
    upcoming: number;
    pending: number;
    done: number;
};

const DOSE_COLUMNS = `
  e.id, e.medication_id, e.schedule_id, e.scheduled_for, e.planned_quantity,
  e.status, e.quantity, e.taken_at, e.note, e.source, e.created_at,
  m.name AS medication_name, m.unit, m.color, m.active AS medication_active
`;

function emptyCounts(): Counts {
    return { total: 0, taken: 0, skipped: 0, due: 0, missed: 0, upcoming: 0, pending: 0, done: 0 };
}

export class Store {
    db: DatabaseSync;
    offsetMinutes: number;
    missAfterMinutes: number;
    reminderWindowMinutes: number;
    private nowFn: () => number;

    constructor(options: StoreOptions) {
        const dbPath = options.dbPath;
        if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
        this.offsetMinutes = options.offsetMinutes ?? Number(process.env.APP_TZ_OFFSET_MINUTES ?? 540);
        this.missAfterMinutes = options.missAfterMinutes ?? Number(process.env.MISS_AFTER_MINUTES ?? 120);
        this.reminderWindowMinutes = options.reminderWindowMinutes ?? Number(process.env.REMINDER_WINDOW_MINUTES ?? 60);
        this.nowFn = options.now ?? (() => Date.now());
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrate();
        // 今日から先の予定だけを補完する。過去の予定を現在の設定から遡って作らない。
        this.ensureEvents(this.today(), addDays(this.today(), 14));
    }

    close(): void {
        this.db.close();
    }

    // ------------------------------------------------------------ time

    now(): { ms: number; date: string; minute: string; stamp: string } {
        const ms = this.nowFn();
        const p = localParts(ms, this.offsetMinutes);
        return { ms, date: p.date, minute: p.minute, stamp: p.stamp };
    }

    today(): string {
        return this.now().date;
    }

    nowMinute(): string {
        return this.now().minute;
    }

    nowStamp(): string {
        return this.now().stamp;
    }

    // ------------------------------------------------------------ schema

    private migrate(): void {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS medications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dose_quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '錠',
  note TEXT,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  low_stock_days INTEGER NOT NULL DEFAULT 7,
  notify INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  time TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '1111111',
  quantity REAL NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dose_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  planned_quantity REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','taken','skipped')),
  quantity REAL NOT NULL DEFAULT 0,
  taken_at TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'schedule',
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  quantity REAL NOT NULL CHECK (quantity > 0),
  purchased_at TEXT NOT NULL,
  price INTEGER,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id TEXT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  delta REAL NOT NULL CHECK (delta != 0),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_log (
  channel TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES dose_events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'dose',
  sent_at TEXT NOT NULL,
  PRIMARY KEY (channel, event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_dose_date ON dose_events(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_dose_med ON dose_events(medication_id, status);
CREATE INDEX IF NOT EXISTS idx_schedule_med ON schedules(medication_id, enabled);
CREATE INDEX IF NOT EXISTS idx_purchase_med ON purchases(medication_id, purchased_at);
CREATE INDEX IF NOT EXISTS idx_adjust_med ON adjustments(medication_id);
`);
    }

    // ------------------------------------------------------------ query helpers

    private all<T>(sql: string, ...params: unknown[]): T[] {
        return this.db.prepare(sql).all(...(params as never[])) as T[];
    }

    private get<T>(sql: string, ...params: unknown[]): T | undefined {
        return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
    }

    private run(sql: string, ...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
        return this.db.prepare(sql).run(...(params as never[]));
    }

    private tx<T>(fn: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    // ------------------------------------------------------------ scheduled events

    /**
     * 指定期間の服薬予定を実体化する。予定を後から変更しても過去の記録は残す。
     * 既存の (schedule_id, scheduled_for) は INSERT OR IGNORE で維持する。
     *
     * 過去日は、たとえ start_date が過去でも現在の予定設定から新規生成しない。
     * 予定を変更した後に履歴を開いても、新しい時刻・曜日・数量が過去へ
     * 遡って現れないようにするための安全弁。既に実体化済みの過去イベントは残す。
     */
    ensureEvents(fromDate: string, toDate: string): void {
        const today = this.today();
        if (fromDate < today) fromDate = today;
        if (fromDate > toDate) return;
        const rows = this.all<ScheduleRow & { med_qty: number; med_active: number }>(
            `SELECT s.*, m.dose_quantity AS med_qty, m.active AS med_active
             FROM schedules s JOIN medications m ON m.id = s.medication_id
             WHERE s.enabled = 1 AND m.active = 1`,
        );
        if (rows.length === 0) return;

        const insert = this.db.prepare(
            `INSERT OR IGNORE INTO dose_events
             (medication_id, schedule_id, scheduled_for, planned_quantity, status, quantity, created_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
        );
        const createdAt = this.nowStamp();
        let date = fromDate;
        let guard = 0;
        while (date <= toDate && guard < 800) {
            for (const s of rows) {
                if (!isScheduleActiveOn(s, date)) continue;
                insert.run(s.medication_id, s.id, `${date}T${s.time}`, s.quantity, createdAt);
            }
            date = addDays(date, 1);
            guard++;
        }
    }

    /** 未来の未服薬イベントを消してから再生成する（時刻・曜日変更用）。 */
    private resetFuturePending(medicationId: string): void {
        const nowMinute = this.nowMinute();
        this.run(
            `DELETE FROM dose_events
             WHERE medication_id = ? AND schedule_id IS NOT NULL AND status = 'pending' AND scheduled_for >= ?`,
            medicationId,
            nowMinute,
        );
        this.ensureEvents(this.today(), addDays(this.today(), 14));
    }

    // ------------------------------------------------------------ medications

    getMedication(id: string): MedicationRow | undefined {
        return this.get<MedicationRow>('SELECT * FROM medications WHERE id = ?', id);
    }

    requireMedication(id: string): MedicationRow {
        const med = this.getMedication(id);
        if (!med) throw new HttpError(404, 'medication not found');
        return med;
    }

    listSchedules(medicationId: string, onlyEnabled = true): ScheduleRow[] {
        return this.all<ScheduleRow>(
            `SELECT * FROM schedules WHERE medication_id = ? ${onlyEnabled ? 'AND enabled = 1' : ''} ORDER BY time, id`,
            medicationId,
        );
    }

    private aggregate(medicationId: string): { purchased: number; consumed: number; adjusted: number } {
        return this.get<{ purchased: number; consumed: number; adjusted: number }>(
            `SELECT
               (SELECT COALESCE(SUM(quantity),0) FROM purchases WHERE medication_id = ?) AS purchased,
               (SELECT COALESCE(SUM(quantity),0) FROM dose_events WHERE medication_id = ? AND status = 'taken') AS consumed,
               (SELECT COALESCE(SUM(delta),0) FROM adjustments WHERE medication_id = ?) AS adjusted`,
            medicationId,
            medicationId,
            medicationId,
        ) ?? { purchased: 0, consumed: 0, adjusted: 0 };
    }

    stats(med: MedicationRow): MedicationStats {
        const today = this.today();
        const schedules = this.listSchedules(med.id, false).filter((s) => s.enabled === 1);
        const agg = this.aggregate(med.id);
        const stock = round2(agg.purchased - agg.consumed + agg.adjusted);
        const daily = computeDailyUse(schedules, today);
        const weekly = computeWeeklyUse(schedules, today);
        const daysLeft = daily > 0 ? Math.max(0, Math.floor(stock / daily)) : null;
        const lowStock = daily > 0 ? (daysLeft as number) <= med.low_stock_days : stock <= 0;
        return {
            ...med,
            active: Boolean(med.active),
            notify: Boolean(med.notify),
            schedules: this.listSchedules(med.id, false).map((s) => ({ ...s, enabled: Boolean(s.enabled) })),
            times: schedules.map((s) => s.time),
            purchased: round2(agg.purchased),
            consumed: round2(agg.consumed),
            adjusted: round2(agg.adjusted),
            stock,
            daily_use: round2(daily),
            weekly_use: round2(weekly),
            days_left: daysLeft,
            run_out_date: daysLeft === null ? null : addDays(today, daysLeft),
            low_stock: lowStock,
        };
    }

    listMedications(includeInactive = false): MedicationStats[] {
        const rows = this.all<MedicationRow>(
            `SELECT * FROM medications ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, created_at`,
        );
        return rows.map((m) => this.stats(m));
    }

    getMedicationStats(id: string): MedicationStats {
        return this.stats(this.requireMedication(id));
    }

    createMedication(input: MedicationInput, schedules: ScheduleInput[]): MedicationStats {
        const id = randomUUID();
        const now = this.nowStamp();
        this.tx(() => {
            const order = this.get<{ n: number }>('SELECT COALESCE(MAX(sort),0) + 1 AS n FROM medications')?.n ?? 1;
            this.run(
                `INSERT INTO medications
                 (id, name, dose_quantity, unit, note, color, active, low_stock_days, notify, sort, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                id,
                input.name,
                input.dose_quantity,
                input.unit,
                input.note,
                input.color,
                input.active ? 1 : 0,
                input.low_stock_days,
                input.notify ? 1 : 0,
                order,
                now,
                now,
            );
            this.replaceSchedulesInternal(id, schedules);
        });
        return this.getMedicationStats(id);
    }

    updateMedication(id: string, input: MedicationInput, schedules?: ScheduleInput[]): MedicationStats {
        const previous = this.requireMedication(id);
        const now = this.nowStamp();
        this.tx(() => {
            this.run(
                `UPDATE medications SET
                   name = ?, dose_quantity = ?, unit = ?, note = ?, color = ?, active = ?,
                   low_stock_days = ?, notify = ?, updated_at = ?
                 WHERE id = ?`,
                input.name,
                input.dose_quantity,
                input.unit,
                input.note,
                input.color,
                input.active ? 1 : 0,
                input.low_stock_days,
                input.notify ? 1 : 0,
                now,
                id,
            );
            if (schedules) {
                this.replaceSchedulesInternal(id, schedules);
            } else if (Boolean(input.active) !== Boolean(previous.active)) {
                // 有効/無効の切り替え時だけ、未来の未服薬イベントを作り直す。
                // schedules を送っていない場合は数量・曜日・期間を暗黙に変更しない。
                this.resetFuturePending(id);
            }
        });
        return this.getMedicationStats(id);
    }

    deactivateMedication(id: string): void {
        this.requireMedication(id);
        this.tx(() => {
            this.run('UPDATE medications SET active = 0, updated_at = ? WHERE id = ?', this.nowStamp(), id);
            this.resetFuturePending(id);
        });
    }

    /**
     * 時刻をキーに予定を差分更新する。削除された時刻の予定は enabled=0 にして履歴を残す。
     */
    replaceSchedules(medicationId: string, schedules: ScheduleInput[]): MedicationStats {
        this.requireMedication(medicationId);
        this.tx(() => this.replaceSchedulesInternal(medicationId, schedules));
        return this.getMedicationStats(medicationId);
    }

    private replaceSchedulesInternal(medicationId: string, schedules: ScheduleInput[]): void {
        const existing = this.listSchedules(medicationId, false);
        const byTime = new Map(existing.map((s) => [s.time, s]));
        const keep = new Set<number>();
        const today = this.today();
        const now = this.nowStamp();

        for (const item of schedules) {
            const found = byTime.get(item.time);
            if (found) {
                keep.add(found.id);
                this.run(
                    `UPDATE schedules SET days = ?, quantity = ?, start_date = ?, end_date = ?, enabled = ?
                     WHERE id = ?`,
                    item.days,
                    item.quantity,
                    item.start_date ?? found.start_date ?? today,
                    item.end_date,
                    item.enabled ? 1 : 0,
                    found.id,
                );
            } else {
                const res = this.run(
                    `INSERT INTO schedules (medication_id, time, days, quantity, start_date, end_date, enabled, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    medicationId,
                    item.time,
                    item.days,
                    item.quantity,
                    item.start_date ?? today,
                    item.end_date,
                    item.enabled ? 1 : 0,
                    now,
                );
                keep.add(Number(res.lastInsertRowid));
            }
        }
        for (const s of existing) {
            if (!keep.has(s.id)) {
                this.run('UPDATE schedules SET enabled = 0 WHERE id = ?', s.id);
            }
        }
        this.run(
            `DELETE FROM dose_events
             WHERE medication_id = ? AND schedule_id IS NOT NULL AND status = 'pending' AND scheduled_for >= ?`,
            medicationId,
            this.nowMinute(),
        );
        this.ensureEvents(today, addDays(today, 14));
    }

    // ------------------------------------------------------------ doses

    private eventView(e: DoseEventRow & { medication_name: string; unit: string; color: string | null; medication_active: number }): EventView {
        const nowMinute = this.nowMinute();
        const minutes = diffMinutes(e.scheduled_for, nowMinute);
        let display: EventView['display_status'];
        if (e.status === 'taken') display = 'taken';
        else if (e.status === 'skipped') display = 'skipped';
        else if (minutes <= -this.missAfterMinutes) display = 'missed';
        else if (minutes <= 0) display = 'due';
        else display = 'upcoming';
        return { ...e, display_status: display, minutes_from_now: minutes };
    }

    getDoses(fromDate: string, toDate: string): EventView[] {
        const today = this.today();
        if (toDate >= today) {
            const ensureTo = toDate > addDays(today, 14) ? toDate : addDays(today, 14);
            this.ensureEvents(today, ensureTo);
        }
        const rows = this.all<DoseEventRow & { medication_name: string; unit: string; color: string | null; medication_active: number }>(
            `SELECT ${DOSE_COLUMNS}
             FROM dose_events e JOIN medications m ON m.id = e.medication_id
             WHERE substr(e.scheduled_for, 1, 10) BETWEEN ? AND ?
             ORDER BY e.scheduled_for, m.name`,
            fromDate,
            toDate,
        );
        return rows.map((r) => this.eventView(r));
    }

    getEvent(id: number): EventView | undefined {
        const row = this.get<DoseEventRow & { medication_name: string; unit: string; color: string | null; medication_active: number }>(
            `SELECT ${DOSE_COLUMNS} FROM dose_events e JOIN medications m ON m.id = e.medication_id WHERE e.id = ?`,
            id,
        );
        return row ? this.eventView(row) : undefined;
    }

    requireEvent(id: number): EventView {
        const e = this.getEvent(id);
        if (!e) throw new HttpError(404, 'dose event not found');
        return e;
    }

    takeDose(id: number, opts: { quantity?: number; taken_at?: string | null; note?: string | null } = {}): { dose: EventView; already: boolean } {
        const current = this.requireEvent(id);
        if (current.status === 'taken') return { dose: current, already: true };
        const quantity = opts.quantity ?? (current.planned_quantity > 0 ? current.planned_quantity : 1);
        const takenAt = opts.taken_at ?? this.nowStamp();
        this.run(
            `UPDATE dose_events SET status = 'taken', quantity = ?, taken_at = ?, note = ? WHERE id = ?`,
            quantity,
            takenAt,
            opts.note ?? current.note,
            id,
        );
        return { dose: this.requireEvent(id), already: false };
    }

    skipDose(id: number, opts: { note?: string | null } = {}): { dose: EventView; already: boolean } {
        const current = this.requireEvent(id);
        if (current.status === 'taken') throw new HttpError(409, 'already taken; undo first');
        if (current.status === 'skipped') return { dose: current, already: true };
        this.run(
            `UPDATE dose_events SET status = 'skipped', quantity = 0, taken_at = NULL, note = ? WHERE id = ?`,
            opts.note ?? current.note,
            id,
        );
        return { dose: this.requireEvent(id), already: false };
    }

    undoDose(id: number): EventView {
        this.requireEvent(id);
        this.run(
            `UPDATE dose_events SET status = 'pending', quantity = 0, taken_at = NULL WHERE id = ?`,
            id,
        );
        return this.requireEvent(id);
    }

    recordDose(input: {
        medication_id: string;
        scheduled_for?: string | null;
        status?: 'taken' | 'skipped' | 'pending';
        quantity?: number | null;
        note?: string | null;
        source?: string;
    }): EventView {
        const med = this.requireMedication(input.medication_id);
        const status = input.status ?? 'taken';
        const scheduledFor = input.scheduled_for ?? this.nowMinute();
        const quantity = input.quantity ?? (status === 'skipped' ? 0 : med.dose_quantity);
        const takenAt = status === 'taken' ? this.nowStamp() : null;
        const res = this.run(
            `INSERT INTO dose_events
             (medication_id, schedule_id, scheduled_for, planned_quantity, status, quantity, taken_at, note, source, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
            med.id,
            scheduledFor,
            quantity,
            status,
            status === 'taken' ? quantity : 0,
            takenAt,
            input.note ?? null,
            input.source ?? 'manual',
            this.nowStamp(),
        );
        return this.requireEvent(Number(res.lastInsertRowid));
    }

    // ------------------------------------------------------------ purchases / adjustments

    addPurchase(input: {
        medication_id: string;
        quantity: number;
        purchased_at?: string | null;
        price?: number | null;
        note?: string | null;
        source?: string;
    }): { purchase: unknown; medication: MedicationStats } {
        const med = this.requireMedication(input.medication_id);
        const purchasedAt = input.purchased_at ?? this.today();
        const res = this.run(
            `INSERT INTO purchases (medication_id, quantity, purchased_at, price, note, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            med.id,
            input.quantity,
            purchasedAt,
            input.price ?? null,
            input.note ?? null,
            input.source ?? 'manual',
            this.nowStamp(),
        );
        const purchase = this.get('SELECT * FROM purchases WHERE id = ?', Number(res.lastInsertRowid));
        return { purchase, medication: this.getMedicationStats(med.id) };
    }

    addAdjustment(input: {
        medication_id: string;
        delta: number;
        reason?: string | null;
        source?: string;
    }): { adjustment: unknown; medication: MedicationStats } {
        const med = this.requireMedication(input.medication_id);
        const res = this.run(
            `INSERT INTO adjustments (medication_id, delta, reason, source, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            med.id,
            input.delta,
            input.reason ?? null,
            input.source ?? 'manual',
            this.nowStamp(),
        );
        const adjustment = this.get('SELECT * FROM adjustments WHERE id = ?', Number(res.lastInsertRowid));
        return { adjustment, medication: this.getMedicationStats(med.id) };
    }

    history(days: number): {
        from: string;
        to: string;
        doses: EventView[];
        purchases: unknown[];
        adjustments: unknown[];
    } {
        const today = this.today();
        const from = addDays(today, -(days - 1));
        const doses = this.getDoses(from, today);
        const purchases = this.all(
            `SELECT p.*, m.name AS medication_name, m.unit FROM purchases p
             JOIN medications m ON m.id = p.medication_id
             WHERE p.purchased_at BETWEEN ? AND ? ORDER BY p.purchased_at DESC, p.id DESC`,
            from,
            today,
        );
        const adjustments = this.all(
            `SELECT a.*, m.name AS medication_name, m.unit FROM adjustments a
             JOIN medications m ON m.id = a.medication_id
             WHERE substr(a.created_at, 1, 10) BETWEEN ? AND ? ORDER BY a.created_at DESC, a.id DESC`,
            from,
            today,
        );
        return { from, to: today, doses, purchases, adjustments };
    }

    // ------------------------------------------------------------ notifications

    dueNotifications(
        channel: string,
        opts: { claim?: boolean; lookbackMinutes?: number } = {},
    ): Array<{
        event_id: number;
        medication_id: string;
        medication_name: string;
        scheduled_for: string;
        quantity: number;
        unit: string;
        message: string;
        minutes_overdue: number;
    }> {
        const claim = opts.claim ?? true;
        const lookback = opts.lookbackMinutes ?? this.reminderWindowMinutes;
        const today = this.today();
        this.ensureEvents(today, today);
        const nowMinute = this.nowMinute();
        const rows = this.all<{ event_id: number; medication_id: string; medication_name: string; scheduled_for: string; planned_quantity: number; unit: string }>(
            `SELECT e.id AS event_id, e.medication_id, e.scheduled_for, e.planned_quantity,
                    m.name AS medication_name, m.unit
             FROM dose_events e JOIN medications m ON m.id = e.medication_id
             WHERE e.status = 'pending' AND m.active = 1 AND m.notify = 1
               AND e.scheduled_for <= ? AND e.scheduled_for >= ?
             ORDER BY e.scheduled_for`,
            nowMinute,
            addMinutes(nowMinute, -lookback),
        );

        const build = (r: (typeof rows)[number]) => {
            const time = r.scheduled_for.slice(11, 16);
            const qty = formatQuantity(r.planned_quantity);
            return {
                event_id: r.event_id,
                medication_id: r.medication_id,
                medication_name: r.medication_name,
                scheduled_for: r.scheduled_for,
                quantity: r.planned_quantity,
                unit: r.unit,
                message: `服薬時間です: ${time} ${r.medication_name}（${qty}${r.unit}）`,
                minutes_overdue: diffMinutes(nowMinute, r.scheduled_for),
            };
        };

        if (!claim) return rows.map(build);

        const inserted: ReturnType<typeof build>[] = [];
        const stmt = this.db.prepare(
            `INSERT OR IGNORE INTO reminder_log (channel, event_id, kind, sent_at) VALUES (?, ?, 'dose', ?)`,
        );
        this.tx(() => {
            for (const row of rows) {
                const res = stmt.run(channel, row.event_id, this.nowStamp());
                if (Number(res.changes) > 0) inserted.push(build(row));
            }
        });
        return inserted;
    }

    // ------------------------------------------------------------ aggregate

    private countsOf(doses: EventView[]): Counts {
        const c = emptyCounts();
        for (const d of doses) {
            c.total++;
            c[d.display_status]++;
        }
        c.pending = c.due + c.missed + c.upcoming;
        c.done = c.taken + c.skipped;
        return c;
    }

    state(date?: string): {
        now: string;
        today: string;
        date: string;
        offset_minutes: number;
        medications: MedicationStats[];
        doses: EventView[];
        counts: Counts;
    } {
        const today = this.today();
        const target = date ?? today;
        const ensureTo = target > addDays(today, 14) ? target : addDays(today, 14);
        if (target >= today) this.ensureEvents(today, ensureTo);
        const medications = this.listMedications(false);
        const doses = this.getDoses(target, target);
        return {
            now: this.nowStamp(),
            today,
            date: target,
            offset_minutes: this.offsetMinutes,
            medications,
            doses,
            counts: this.countsOf(doses),
        };
    }

    summary(): {
        now: string;
        today: string;
        offset_minutes: number;
        counts: Counts;
        medications: MedicationStats[];
        low_stock: MedicationStats[];
        alerts: Array<{ type: string; medication_id: string; name: string; message: string }>;
        next_dose: EventView | null;
        doses: EventView[];
    } {
        const today = this.today();
        this.ensureEvents(today, addDays(today, 14));
        const medications = this.listMedications(false);
        const doses = this.getDoses(today, today);
        const low = medications.filter((m) => m.low_stock);
        const next = doses.find((d) => d.display_status === 'due') ?? doses.find((d) => d.display_status === 'upcoming') ?? null;
        return {
            now: this.nowStamp(),
            today,
            offset_minutes: this.offsetMinutes,
            counts: this.countsOf(doses),
            medications,
            low_stock: low,
            alerts: low.map((m) => ({
                type: 'low_stock',
                medication_id: m.id,
                name: m.name,
                message:
                    m.days_left === null || m.days_left <= 0
                        ? `${m.name} の在庫がありません`
                        : `${m.name} の残りは約${m.days_left}日分です`,
            })),
            next_dose: next,
            doses,
        };
    }
}
