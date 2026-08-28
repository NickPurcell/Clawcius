import { DEFAULT_TIMEZONE, zonedStamp } from './schedule.js';

/** PT and labelled. The format every listing and mail shares. */
export function stamp(at: number): string {
  return zonedStamp(at, DEFAULT_TIMEZONE);
}

/** The Pacific instant beside a schedule-zone one, or nothing when identical. */
export function alsoIn(at: number, timeZone: string): string {
  const here = stamp(at);
  return zonedStamp(at, timeZone) === here ? '' : ` (${here})`;
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: false };
}

/** `isError` so a refusal is not mistaken for a receipt when the result is skimmed. */
export function refuse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
