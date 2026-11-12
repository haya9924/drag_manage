/**
 * HTTP 層。UI 用 API と Hermes 用 API (/api/agent/*) を提供する。
 *
 * /api/agent/* は HERMES_TOKEN（未設定なら INGEST_TOKEN）による Bearer 認証。
 * トークンが未設定の場合は fail closed とし、/api/agent/* を一切公開しない。
 * 認証後は /api/* と同じハンドラへ委譲するため、UI の操作 API は
 * すべて Hermes からも同じ形で呼べる。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { HttpError } from './errors.ts';
import { Store } from './store.ts';
import type { MedicationInput, MedicationRow, ScheduleInput } from './store.ts';
import { isValidDate, isValidMinute, isValidStamp, isValidTime, normalizeDays } from './time.ts';

export type AppOptions = {
    dbPath?: string;
    publicDir?: string;
    token?: string;
    offsetMinutes?: number;
    now?: () => number;
    missAfterMinutes?: number;
    reminderWindowMinutes?: number;
};

type JsonBody = Record<string, unknown>;

const MAX_BODY = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, 'body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new HttpError(400, 'invalid JSON body');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'JSON body must be an object');
    }
    return parsed as JsonBody;
}

// ------------------------------------------------------------ validation

function asString(value: unknown, name: string, opts: { required?: boolean; max?: number; fallback?: string } = {}): string {
    if (value === undefined || value === null) {
        if (opts.required) throw new HttpError(400, `${name} is required`);
        return opts.fallback ?? '';
    }
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
    const s = value.trim();
    if (opts.required && !s) throw new HttpError(400, `${name} is required`);
    const max = opts.max ?? 200;
    if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
    return s;
}

function asNullableString(value: unknown, name: string, max = 500): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
    const s = value.trim();
    if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
    return s || null;
}

function asNumber(
    value: unknown,
    name: string,
    opts: { fallback?: number; min?: number; max?: number; integer?: boolean } = {},
): number {
    if (value === undefined || value === null || value === '') {
        if (opts.fallback !== undefined) return opts.fallback;
        throw new HttpError(400, `${name} is required`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new HttpError(400, `${name} must be a number`);
    }
    if (opts.integer && !Number.isInteger(value)) throw new HttpError(400, `${name} must be an integer`);
    if (opts.min !== undefined && value < opts.min) throw new HttpError(400, `${name} must be >= ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) throw new HttpError(400, `${name} must be <= ${opts.max}`);
    return value;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    throw new HttpError(400, 'boolean field must be true or false');
}

function asDate(value: unknown, name: string, fallback: string | null = null): string | null {
    if (value === undefined || value === null || value === '') return fallback;
    if (!isValidDate(value)) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
    return value;
}

function daysOf(value: unknown): string {
    try {
        return normalizeDays(value);
    } catch (err) {
        throw new HttpError(400, (err as Error).message);
    }
}

function medicationInput(body: JsonBody, base?: MedicationRow): MedicationInput {
    const name = body.name !== undefined ? asString(body.name, 'name', { required: true, max: 100 }) : base?.name;
    if (!name) throw new HttpError(400, 'name is required');

    let color: string | null;
    if (body.color !== undefined) {
        color = asNullableString(body.color, 'color', 20);
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'color must be #RRGGBB');
    } else {
        color = base?.color ?? null;
    }

    return {
        name,
        dose_quantity:
            body.dose_quantity !== undefined
                ? asNumber(body.dose_quantity, 'dose_quantity', { min: 0.01, max: 100000 })
                : base?.dose_quantity ?? 1,
        unit: body.unit !== undefined ? asString(body.unit, 'unit', { max: 20 }) || '錠' : base?.unit ?? '錠',
        note: body.note !== undefined ? asNullableString(body.note, 'note', 1000) : base?.note ?? null,
        color,
        low_stock_days:
            body.low_stock_days !== undefined
                ? asNumber(body.low_stock_days, 'low_stock_days', { min: 0, max: 3650, integer: true })
                : base?.low_stock_days ?? 7,
        notify: body.notify !== undefined ? asBoolean(body.notify, true) : base ? Boolean(base.notify) : true,
        active: body.active !== undefined ? asBoolean(body.active, true) : base ? Boolean(base.active) : true,
    };
}

function parseSchedules(body: JsonBody, doseQuantity: number): ScheduleInput[] | undefined {
    let items: unknown[] | undefined;
    if (body.schedules !== undefined) {
        if (!Array.isArray(body.schedules)) throw new HttpError(400, 'schedules must be an array');
        items = body.schedules;
    } else if (body.times !== undefined) {
        if (!Array.isArray(body.times)) throw new HttpError(400, 'times must be an array');
        const days = daysOf(body.days);
        items = body.times.map((time) => ({ time, days, quantity: body.quantity }));
    } else {
        return undefined;
    }
    if (items.length > 24) throw new HttpError(400, 'at most 24 schedules are allowed');

    const seen = new Set<string>();
    const result: ScheduleInput[] = items.map((raw) => {
        const item: JsonBody = typeof raw === 'string' ? { time: raw } : (raw as JsonBody);
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new HttpError(400, 'schedule must be an object');
        }
        const time = asString(item.time, 'schedule.time', { required: true, max: 5 });
        if (!isValidTime(time)) throw new HttpError(400, 'schedule.time must be HH:MM');
        if (seen.has(time)) throw new HttpError(400, `duplicate schedule time: ${time}`);
        seen.add(time);

        const days = daysOf(item.days);
        const quantity =
            item.quantity !== undefined
                ? asNumber(item.quantity, 'schedule.quantity', { min: 0.01, max: 100000 })
                : doseQuantity;
        const start = asDate(item.start_date, 'schedule.start_date');
        const end = asDate(item.end_date, 'schedule.end_date');
        if (start && end && start > end) throw new HttpError(400, 'schedule.start_date must be <= end_date');
        return {
            time,
            days,
            quantity,
            start_date: start,
            end_date: end,
            enabled: item.enabled !== undefined ? asBoolean(item.enabled, true) : true,
        };
    });
    return result;
}

// ------------------------------------------------------------ routing

export function createApp(options: AppOptions = {}): { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>; store: Store } {
    const root = join(import.meta.dirname, '..');
    const store = new Store({
        dbPath: options.dbPath ?? join(root, 'data', 'app.db'),
        offsetMinutes: options.offsetMinutes,
        now: options.now,
        missAfterMinutes: options.missAfterMinutes,
        reminderWindowMinutes: options.reminderWindowMinutes,
    });
    const publicDir = options.publicDir ?? join(root, 'public');
    const envToken = process.env.HERMES_TOKEN?.trim() || process.env.INGEST_TOKEN?.trim() || '';
    const token = options.token ?? envToken;

    function authorized(req: IncomingMessage): boolean {
        // トークン未設定時に全公開へフォールバックしない（fail closed）。
        if (!token) return false;
        return req.headers.authorization === `Bearer ${token}`;
    }

    function notifications(req: IncomingMessage, res: ServerResponse, url: URL, defaultChannel: string): void {
        const channel = url.searchParams.get('channel') ?? defaultChannel;
        if (!/^[a-z0-9_-]{1,32}$/.test(channel)) throw new HttpError(400, 'channel must be 1-32 chars of [a-z0-9_-]');
        const claim = url.searchParams.get('claim') !== '0' && url.searchParams.get('claim') !== 'false';
        const lookbackRaw = url.searchParams.get('lookback');
        const lookback =
            lookbackRaw === null
                ? store.reminderWindowMinutes
                : asNumber(Number(lookbackRaw), 'lookback', { min: 1, max: 1440, integer: true });
        const notifications = store.dueNotifications(channel, { claim, lookbackMinutes: lookback });
        json(res, 200, {
            now: store.nowStamp(),
            channel,
            claimed: claim,
            lookback_minutes: lookback,
            notifications,
        });
    }

    async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = (req.method ?? 'GET').toUpperCase();
        const url = new URL(req.url ?? '/', 'http://localhost');
        let p = url.pathname;
        if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

        // Hermes 用 API: 認証後、専用エンドポイント以外は通常 API へ委譲
        if (p === '/api/agent' || p.startsWith('/api/agent/')) {
            if (!authorized(req)) throw new HttpError(401, 'unauthorized');
            if (method === 'GET' && p === '/api/agent/summary') {
                json(res, 200, store.summary());
                return;
            }
            if (method === 'GET' && p === '/api/agent/low-stock') {
                const s = store.summary();
                json(res, 200, { today: s.today, low_stock: s.low_stock, alerts: s.alerts });
                return;
            }
            if (method === 'GET' && p === '/api/agent/notifications/due') {
                notifications(req, res, url, 'hermes');
                return;
            }
            p = `/api${p.slice('/api/agent'.length)}`;
        }

        if (method === 'GET' && (p === '/api/health' || p === '/api')) {
            json(res, 200, { ok: true, now: store.nowStamp() });
            return;
        }

        // -------------------------------------------------------- state / meds
        if (method === 'GET' && p === '/api/state') {
            const date = asDate(url.searchParams.get('date'), 'date', null);
            json(res, 200, store.state(date ?? undefined));
            return;
        }

        if (method === 'GET' && p === '/api/medications') {
            json(res, 200, { medications: store.listMedications(false) });
            return;
        }

        if (method === 'POST' && p === '/api/medications') {
            const body = await readJson(req);
            const input = medicationInput(body);
            const schedules = parseSchedules(body, input.dose_quantity) ?? [];
            json(res, 201, { medication: store.createMedication(input, schedules) });
            return;
        }

        let match = p.match(/^\/api\/medications\/([^/]+)$/);
        if (match) {
            const id = decodeURIComponent(match[1]);
            if (method === 'GET') {
                json(res, 200, { medication: store.getMedicationStats(id) });
                return;
            }
            if (method === 'PATCH') {
                const base = store.requireMedication(id);
                const body = await readJson(req);
                const input = medicationInput(body, base);
                const schedules = parseSchedules(body, input.dose_quantity);
                json(res, 200, { medication: store.updateMedication(id, input, schedules) });
                return;
            }
            if (method === 'DELETE') {
                store.deactivateMedication(id);
                json(res, 200, { ok: true, deactivated: id });
                return;
            }
        }

        match = p.match(/^\/api\/medications\/([^/]+)\/schedules$/);
        if (match && (method === 'PUT' || method === 'POST')) {
            const id = decodeURIComponent(match[1]);
            const med = store.requireMedication(id);
            const body = await readJson(req);
            const schedules = parseSchedules(body, med.dose_quantity);
            if (!schedules) throw new HttpError(400, 'schedules or times is required');
            json(res, 200, { medication: store.replaceSchedules(id, schedules) });
            return;
        }

        match = p.match(/^\/api\/medications\/([^/]+)\/purchases$/);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]);
            const body = await readJson(req);
            const result = store.addPurchase({
                medication_id: id,
                quantity: asNumber(body.quantity, 'quantity', { min: 0.01, max: 100000 }),
                purchased_at: asDate(body.purchased_at, 'purchased_at', store.today()),
                price: body.price === undefined || body.price === null ? null : asNumber(body.price, 'price', { min: 0, integer: true }),
                note: asNullableString(body.note, 'note', 500),
                source: body.source === 'hermes' ? 'hermes' : 'manual',
            });
            json(res, 201, result);
            return;
        }

        match = p.match(/^\/api\/medications\/([^/]+)\/adjustments$/);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]);
            const body = await readJson(req);
            const delta = asNumber(body.delta, 'delta', { min: -100000, max: 100000 });
            if (delta === 0) throw new HttpError(400, 'delta must not be 0');
            const result = store.addAdjustment({
                medication_id: id,
                delta,
                reason: asNullableString(body.reason, 'reason', 500),
                source: body.source === 'hermes' ? 'hermes' : 'manual',
            });
            json(res, 201, result);
            return;
        }

        // -------------------------------------------------------- doses
        if (method === 'GET' && p === '/api/doses') {
            const date = asDate(url.searchParams.get('date'), 'date', null);
            let from: string;
            let to: string;
            if (date) {
                from = date;
                to = date;
            } else {
                from = asDate(url.searchParams.get('from'), 'from', store.today()) as string;
                to = asDate(url.searchParams.get('to'), 'to', store.today()) as string;
            }
            if (from > to) throw new HttpError(400, 'from must be <= to');
            const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
            if (span > 366) throw new HttpError(400, 'range must be 366 days or less');
            json(res, 200, { from, to, doses: store.getDoses(from, to) });
            return;
        }

        if (method === 'POST' && p === '/api/doses') {
            const body = await readJson(req);
            const medicationId = asString(body.medication_id, 'medication_id', { required: true, max: 100 });
            let status: 'taken' | 'skipped' | 'pending' = 'taken';
            if (body.status !== undefined) {
                const s = asString(body.status, 'status', { required: true, max: 10 });
                if (s !== 'taken' && s !== 'skipped' && s !== 'pending') throw new HttpError(400, 'status must be taken, skipped, or pending');
                status = s;
            }
            const scheduledFor = body.scheduled_for === undefined || body.scheduled_for === null || body.scheduled_for === ''
                ? null
                : asString(body.scheduled_for, 'scheduled_for', { max: 16 });
            if (scheduledFor && !isValidMinute(scheduledFor)) throw new HttpError(400, 'scheduled_for must be YYYY-MM-DDTHH:mm');
            const quantity =
                body.quantity === undefined || body.quantity === null
                    ? null
                    : asNumber(body.quantity, 'quantity', { min: 0, max: 100000 });
            const dose = store.recordDose({
                medication_id: medicationId,
                scheduled_for: scheduledFor,
                status,
                quantity,
                note: asNullableString(body.note, 'note', 500),
                source: body.source === 'hermes' ? 'hermes' : 'manual',
            });
            json(res, 201, { dose });
            return;
        }

        match = p.match(/^\/api\/doses\/(\d+)\/(take|skip|undo)$/);
        if (match && method === 'POST') {
            const id = Number(match[1]);
            const action = match[2];
            const body = action === 'undo' ? {} : await readJson(req);
            if (action === 'take') {
                const quantity =
                    body.quantity === undefined || body.quantity === null
                        ? undefined
                        : asNumber(body.quantity, 'quantity', { min: 0.01, max: 100000 });
                let takenAt: string | null | undefined = undefined;
                if (body.taken_at !== undefined && body.taken_at !== null && body.taken_at !== '') {
                    const raw = asString(body.taken_at, 'taken_at', { max: 19 });
                    if (!isValidStamp(raw) && !isValidMinute(raw)) throw new HttpError(400, 'taken_at must be YYYY-MM-DDTHH:mm[:ss]');
                    takenAt = raw.length === 16 ? `${raw}:00` : raw;
                }
                json(res, 200, store.takeDose(id, { quantity, taken_at: takenAt, note: asNullableString(body.note, 'note', 500) }));
                return;
            }
            if (action === 'skip') {
                json(res, 200, store.skipDose(id, { note: asNullableString(body.note, 'note', 500) }));
                return;
            }
            json(res, 200, { dose: store.undoDose(id) });
            return;
        }

        if (method === 'GET' && p === '/api/history') {
            const rawDays = url.searchParams.get('days');
            const days = rawDays === null ? 30 : asNumber(Number(rawDays), 'days', { min: 1, max: 365, integer: true });
            json(res, 200, store.history(days));
            return;
        }

        if (method === 'GET' && p === '/api/notifications/due') {
            notifications(req, res, url, 'web');
            return;
        }

        // -------------------------------------------------------- static
        if (method === 'GET' && (p === '/' || p === '/index.html')) {
            const file = join(publicDir, 'index.html');
            if (existsSync(file)) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
                res.end(readFileSync(file));
                return;
            }
        }

        const staticOk = /^[\w./-]+$/.test(p) && !p.includes('..');
        const file = join(publicDir, p);
        if (method === 'GET' && staticOk && existsSync(file)) {
            const mime: Record<string, string> = {
                '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.html': 'text/html; charset=utf-8',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.webmanifest': 'application/manifest+json',
                '.json': 'application/json; charset=utf-8',
                '.ico': 'image/x-icon',
            };
            res.writeHead(200, {
                'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(readFileSync(file));
            return;
        }

        throw new HttpError(404, 'not found');
    }

    async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            await route(req, res);
        } catch (err) {
            if (err instanceof HttpError) {
                json(res, err.status, { error: err.message });
                return;
            }
            console.error(err);
            if (!res.headersSent) json(res, 500, { error: 'internal error' });
            else res.end();
        }
    }

    return { handler, store };
}
