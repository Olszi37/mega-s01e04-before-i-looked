import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const night = '2026-10-28';
const event = { at: '2026-10-28T23:00:00+01:00', job: 'job', owner: 'rook', status: 'ok' };
let runsDir: string;

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'rig-reader-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

function writeEvents(events: unknown[]) {
  writeFileSync(join(runsDir, `${night}.jsonl`), events.map(value => JSON.stringify(value)).join('\n'));
}

describe('readNight', () => {
  it('reads the real fixture without changing it, retaining recovery errors and missing owners', () => {
    const digest = readNight('runs', night)!;
    expect(digest.badLines).toBe(1);
    expect(digest.rows.map(row => row.job)).toEqual([
      'digest/render', 'fixtures/refresh', 'lane/sync', 'notes/backup', 'rig/rotate-logs',
    ]);
    expect(digest.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
    expect(digest.rows[0]).toMatchObject({ owner: null, runs: 1, lastError: null });
    expect(digest.rows[1]).toEqual({
      job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok',
      lastError: 'upstream 503', firstAt: '2026-10-29T01:30:00+01:00',
      lastAt: '2026-10-29T01:37:00+01:00', hasFailure: false,
    });
    expect(digest.rows[2]).toMatchObject({ runs: 8, retries: 1, lastError: 'lock held' });
    expect(digest.rows[3]).toMatchObject({ lastStatus: 'fail', lastError: 'quota exceeded', hasFailure: true });
  });

  it('orders by instant across offsets and retains the latest actual error after recovery', () => {
    writeEvents([
      { ...event, at: '2026-10-29T01:00:00+02:00', owner: null },
      { ...event, at: '2026-10-28T21:30:00-01:00', status: 'fail', error: 'latest error' },
      { ...event, at: '2026-10-29T00:00:00+02:00', status: 'retry', error: 'earlier error' },
    ]);
    expect(readNight(runsDir, night)).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 1, fail: 1 },
      rows: [{ job: 'job', owner: null, runs: 3, retries: 1, lastStatus: 'ok',
        lastError: 'latest error', firstAt: '2026-10-29T00:00:00+02:00',
        lastAt: '2026-10-29T01:00:00+02:00', hasFailure: true }],
    });
  });

  it('breaks equal-instant ties by file order, including empty errors', () => {
    writeEvents([
      { ...event, at: '2026-10-28T23:00:00.1000+01:00', error: 'old' },
      { ...event, at: '2026-10-28T22:00:00.1Z', status: 'retry', owner: null, error: '' },
    ]);
    expect(readNight(runsDir, night)!.rows[0]).toMatchObject({
      owner: null, lastStatus: 'retry', lastError: '',
      firstAt: '2026-10-28T23:00:00.1000+01:00', lastAt: '2026-10-28T22:00:00.1Z',
    });
  });

  it('compares sub-millisecond timestamps without truncation', () => {
    writeEvents([
      { ...event, at: '2026-10-28T22:00:00.0002Z', status: 'retry' },
      { ...event, at: '2026-10-28T22:00:00.0001Z' },
    ]);
    expect(readNight(runsDir, night)!.rows[0]).toMatchObject({
      lastStatus: 'retry', firstAt: '2026-10-28T22:00:00.0001Z', lastAt: '2026-10-28T22:00:00.0002Z',
    });
  });

  it('counts malformed JSON and invalid schemas without adding events', () => {
    const { owner, ...withoutOwner } = event;
    const invalid = [null, [], 3, 'text', {}, withoutOwner,
      { ...event, job: '' }, { ...event, job: 12 }, { ...event, owner: 1 },
      { ...event, status: 'pending' }, { ...event, error: null }, { ...event, at: false }];
    writeFileSync(join(runsDir, `${night}.jsonl`), ` \r\nnot JSON\n${invalid.map(value => JSON.stringify(value)).join('\r\n')}\n${JSON.stringify({ ...event, extra: true })}\n\t\n`);
    const digest = readNight(runsDir, night)!;
    expect(digest.badLines).toBe(invalid.length + 1);
    expect(digest.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
    expect(digest.rows).toHaveLength(1);
  });

  it.each([
    '2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z', '1900-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z', '2026-00-01T12:00:00Z', '2026-13-01T12:00:00Z',
    '2026-01-00T12:00:00Z', '2026-01-01T24:01:00Z', '2026-01-01T12:60:00Z',
    '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00', '2026-01-01T12:00:00+01:60',
    '2026-01-01T12:00:00', '2026-01-01', 'not a date', '2026-01-01T12:00:00Z\n',
  ])('rejects invalid or unzoned timestamps: %s', at => {
    writeEvents([{ ...event, at }]);
    expect(readNight(runsDir, night)).toMatchObject({ badLines: 1, rows: [], counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each(['2000-02-29T12:00:00Z', '2024-02-29T12:00:00.123+05:30', '0000-02-29T12:00:00-03:30'])(
    'accepts valid leap dates and preserves offsets: %s', at => {
      writeEvents([{ ...event, at }]);
      expect(readNight(runsDir, night)).toMatchObject({ badLines: 0, rows: [{ firstAt: at, lastAt: at }] });
    },
  );

  it('returns an empty digest for an empty or whitespace-only file', () => {
    for (const contents of ['', '\r\n  \n\t\n']) {
      writeFileSync(join(runsDir, `${night}.jsonl`), contents);
      expect(readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    }
  });

  it('returns null for missing files and unsafe or malformed basenames', () => {
    expect(readNight(runsDir, night)).toBeNull();
    writeEvents([event]);
    for (const name of ['', '../2026-10-28', '..\\2026-10-28', '2026-10-28.jsonl', '/2026-10-28', '2026-1-1', '2026-10-28\n']) {
      expect(readNight(runsDir, name)).toBeNull();
    }
  });

  it('propagates filesystem errors other than a missing file', () => {
    mkdirSync(join(runsDir, `${night}.jsonl`));
    expect(() => readNight(runsDir, night)).toThrow();
  });
});
