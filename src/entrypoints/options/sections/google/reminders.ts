import { SettingsSchema } from '../../../../domain/settings/schema';

export const DEFAULT_REMINDERS: readonly number[] = [60, 15, 5];

const schema = SettingsSchema.shape.calendar.shape.reminders;

/** Whether the settings schema accepts one more reminder (its own `.max`). */
export function canAddReminder(count: number): boolean {
  return schema.safeParse(Array.from({ length: count + 1 }, () => 1)).success;
}

/** Positive whole minutes only, as written; null when any entry is not (or the schema refuses the list). */
export function parseReminders(raw: readonly string[]): number[] | null {
  const out: number[] = [];
  for (const r of raw) {
    const t = r.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    out.push(n);
  }
  return schema.safeParse(out).success ? out : null;
}
