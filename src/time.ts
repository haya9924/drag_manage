/**
 * ローカル時刻ユーティリティ。
 *
 * DB には "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" のような
 * タイムゾーンなしのローカル文字列で保存する。日本時間には夏時間がないため、
 * 固定オフセット（既定 +540 分）で十分。文字列比較で時系列比較ができる。
 */

export const DEFAULT_TZ_OFFSET_MINUTES = 540;

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

type LocalParts = {
    date: string;
    time: string;
    minute: string;
    stamp: string;
    week: number;
};

/** epoch ms をローカル日時へ変換する（UTC getter をオフセット付きで使う）。 */
export function localParts(ms: number, offsetMinutes: number): LocalParts {
    const d = new Date(ms + offsetMinutes * 60_000);
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    return {
        date,
        time,
        minute: `${date}T${time}`,
        stamp: `${date}T${time}:${pad2(d.getUTCSeconds())}`,
        week: (d.getUTCDay() + 6) % 7, // 0=月 … 6=日
    };
}

export function isValidDate(s: unknown): s is string {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidTime(s: unknown): s is string {
    if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
    const [h, m] = s.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function isValidMinute(s: unknown): s is string {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && isValidDate(s.slice(0, 10)) && isValidTime(s.slice(11, 16));
}

export function isValidStamp(s: unknown): s is string {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) && isValidDate(s.slice(0, 10)) && isValidTime(s.slice(11, 16));
}

/** YYYY-MM-DD に日数を加算する。 */
export function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DDTHH:mm" に分を加算する。 */
export function addMinutes(minute: string, minutes: number): string {
    const d = new Date(minuteMs(minute) + minutes * 60_000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** ローカル日時文字列を、比較用の epoch ms（ローカル naive を UTC とみなす）へ。 */
export function minuteMs(s: string): number {
    return Date.parse(s.length === 16 ? `${s}:00Z` : `${s}Z`);
}

/** ローカル日時の差（分）。 */
export function diffMinutes(a: string, b: string): number {
    return Math.round((minuteMs(a) - minuteMs(b)) / 60_000);
}

/** 0=月 … 6=日 */
export function weekdayIndex(date: string): number {
    return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function normalizeDays(value: unknown): string {
    if (value === undefined || value === null || value === '') return '1111111';
    if (typeof value === 'string') {
        if (!/^[01]{7}$/.test(value)) throw new Error('days must be 7 characters of 0/1 (Mon..Sun)');
        return value;
    }
    if (Array.isArray(value)) {
        let mask = '0000000';
        for (const v of value) {
            if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 6) {
                throw new Error('days array must contain integers 0..6 (0=Mon)');
            }
            const i = v as number;
            mask = `${mask.slice(0, i)}1${mask.slice(i + 1)}`;
        }
        return mask;
    }
    throw new Error('days must be a 7-character mask or an array of weekdays');
}

export type ScheduleLike = {
    days: string;
    start_date: string | null;
    end_date: string | null;
    enabled?: number | boolean;
};

/** その日に服薬予定があるか。 */
export function isScheduleActiveOn(s: ScheduleLike, date: string): boolean {
    if (s.enabled === 0 || s.enabled === false) return false;
    if (s.start_date && date < s.start_date) return false;
    if (s.end_date && date > s.end_date) return false;
    return s.days[weekdayIndex(date)] === '1';
}

/** 曜日・期間を考慮した「1日あたりの平均服薬量」。 */
export function computeDailyUse(schedules: Array<ScheduleLike & { quantity: number }>, today: string): number {
    let total = 0;
    for (let i = 0; i < 7; i++) {
        const date = addDays(today, i);
        for (const s of schedules) {
            if (isScheduleActiveOn(s, date)) total += s.quantity;
        }
    }
    return total / 7;
}

/** 1週間あたりの予定量。 */
export function computeWeeklyUse(schedules: Array<ScheduleLike & { quantity: number }>, today: string): number {
    let total = 0;
    for (let i = 0; i < 7; i++) {
        const date = addDays(today, i);
        for (const s of schedules) {
            if (isScheduleActiveOn(s, date)) total += s.quantity;
        }
    }
    return total;
}

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** 数量表示（1 / 0.5 / 1.25）。 */
export function formatQuantity(n: number): string {
    return String(Math.round(n * 100) / 100);
}
