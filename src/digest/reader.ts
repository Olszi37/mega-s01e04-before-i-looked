import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, NightDigest, ReadNight } from './types.js';

type Event = {
  at: string;
  job: string;
  owner: string | null;
  status: DigestStatus;
  error?: string;
  second: number;
  fraction: string;
};

function parseEvent(value: unknown): Event | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.job !== 'string' || event.job.length === 0 ||
    typeof event.at !== 'string' ||
    (typeof event.owner !== 'string' && event.owner !== null) ||
    (event.status !== 'ok' && event.status !== 'retry' && event.status !== 'fail') ||
    ('error' in event && typeof event.error !== 'string')
  ) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(event.at);
  if (!match || match[0] !== event.at) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
  ) return null;

  // Validate the calendar before parsing: Date.parse normalizes dates like February 30.
  // Keep fractions separate so sub-millisecond events still have their true order.
  const second = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${offset}`);
  if (!Number.isFinite(second)) return null;
  return {
    at: event.at, job: event.job, owner: event.owner, status: event.status,
    error: event.error as string | undefined, second, fraction: fraction.replace(/0+$/, ''),
  };
}

export const readNight: ReadNight = (runsDir, night) => {
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const digest: NightDigest = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const events: Event[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: Event | null;
    try {
      event = parseEvent(JSON.parse(line));
    } catch {
      event = null;
    }
    if (event === null) digest.badLines++;
    else events.push(event);
  }

  // Stable sorting preserves file order for equal instants.
  events.sort((a, b) => a.second - b.second || (a.fraction < b.fraction ? -1 : a.fraction > b.fraction ? 1 : 0));
  const rows = new Map<string, DigestRow>();
  for (const event of events) {
    digest.counts[event.status]++;
    const row = rows.get(event.job) ?? {
      job: event.job, owner: event.owner, runs: 0, retries: 0,
      lastStatus: event.status, lastError: null, firstAt: event.at, lastAt: event.at, hasFailure: false,
    };
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (event.status === 'fail') row.hasFailure = true;
    row.owner = event.owner;
    row.lastStatus = event.status;
    row.lastAt = event.at;
    if (event.error !== undefined) row.lastError = event.error;
    rows.set(event.job, row);
  }
  digest.rows = [...rows.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return digest;
};
