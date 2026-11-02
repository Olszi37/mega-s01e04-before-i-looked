import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const configFor = (runsDir: string) => ({
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir,
});

const tempDirs: string[] = [];

async function makeRunsDir() {
  const dir = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
  tempDirs.push(dir);
  return dir;
}

async function writeNight(runsDir: string, night: string, content: string) {
  await writeFile(join(runsDir, `${night}.jsonl`), content, 'utf8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('digest routes', () => {
  it('renders HTML and JSON for the same sorted rows and preserves failure history and offsets', async () => {
    const runsDir = await makeRunsDir();
    const night = '2026-10-29';
    await writeNight(
      runsDir,
      night,
      [
        JSON.stringify({ at: '2026-10-29T09:15:00+02:00', job: 'zeta', status: 'retry', owner: 'Zed', error: 'transient' }),
        JSON.stringify({ at: '2026-10-29T08:00:00+02:00', job: 'alpha', status: 'ok', owner: null }),
        JSON.stringify({ at: '2026-10-29T09:00:00+02:00', job: 'alpha', status: 'fail', owner: 'Ada', error: 'first failure' }),
        JSON.stringify({ at: '2026-10-29T09:05:00+02:00', job: 'zeta', status: 'retry', owner: 'Zed', error: 'second retry' }),
        JSON.stringify({ at: '2026-10-29T09:10:00+02:00', job: 'zeta', status: 'retry', owner: 'Zed', error: 'third retry' }),
        JSON.stringify({ at: '2026-10-29T09:20:00+02:00', job: 'alpha', status: 'ok', owner: null }),
      ].join('\n'),
    );
    const app = createApp(configFor(runsDir));

    const htmlResponse = await app.request(`/digest/${night}`);
    const html = await htmlResponse.text();
    const jsonResponse = await app.request(`/api/digest/${night}`);
    const digest = await jsonResponse.json();

    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('alpha');
    expect(html).toContain('zeta');
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get('content-type')).toContain('application/json');
    expect(digest).toEqual({
      night,
      rows: [
        {
          job: 'alpha', owner: null, runs: 3, retries: 0, lastStatus: 'ok',
          lastError: 'first failure', firstAt: '2026-10-29T08:00:00+02:00',
          lastAt: '2026-10-29T09:20:00+02:00', hasFailure: true,
        },
        {
          job: 'zeta', owner: 'Zed', runs: 3, retries: 3, lastStatus: 'retry',
          lastError: 'transient', firstAt: '2026-10-29T09:05:00+02:00',
          lastAt: '2026-10-29T09:15:00+02:00', hasFailure: false,
        },
      ],
      badLines: 0,
      counts: { ok: 2, retry: 3, fail: 1 },
    });

    const rowMarkup = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
    const displayedJobs = rowMarkup
      .map((row) => (row.match(/<td\b[^>]*>(.*?)<\/td>/s)?.[1] ?? '').replace(/<[^>]*>/g, '').trim())
      .filter((job) => job === 'alpha' || job === 'zeta');
    expect(displayedJobs).toEqual(['alpha', 'zeta']);
    const alphaRow = rowMarkup.find((row) => row.includes('alpha')) ?? '';
    const zetaRow = rowMarkup.find((row) => row.includes('zeta')) ?? '';
    expect(alphaRow).toMatch(/class="warn"/);
    expect(zetaRow).toMatch(/class="warn"/);
    expect(html).toContain('—');
    expect(html).toContain('first failure');
    expect(zetaRow).toContain('3');
  });

  it('returns 404 for a night with no file in both formats', async () => {
    const app = createApp(configFor(await makeRunsDir()));

    const html = await app.request('/digest/2026-10-30');
    const json = await app.request('/api/digest/2026-10-30');

    expect(html.status).toBe(404);
    expect(json.status).toBe(404);
  });

  it('renders an empty night with no rows and zero counts', async () => {
    const runsDir = await makeRunsDir();
    const night = '2026-10-31';
    await writeNight(runsDir, night, '');
    const app = createApp(configFor(runsDir));

    const htmlResponse = await app.request(`/digest/${night}`);
    const html = await htmlResponse.text();
    const jsonResponse = await app.request(`/api/digest/${night}`);

    expect(htmlResponse.status).toBe(200);
    expect(html.toLowerCase()).toContain('nothing ran');
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({
      night,
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('counts malformed lines and retains valid rows in the page and JSON', async () => {
    const runsDir = await makeRunsDir();
    const night = '2026-11-01';
    await writeNight(
      runsDir,
      night,
      [
        '{not valid json',
        JSON.stringify({ at: '2026-11-01T07:30:00-04:00', job: 'kept-job', status: 'ok', owner: 'Kai' }),
      ].join('\n'),
    );
    const app = createApp(configFor(runsDir));

    const htmlResponse = await app.request(`/digest/${night}`);
    const html = await htmlResponse.text();
    const jsonResponse = await app.request(`/api/digest/${night}`);
    const digest = await jsonResponse.json();

    expect(htmlResponse.status).toBe(200);
    expect(html).toContain('kept-job');
    expect(jsonResponse.status).toBe(200);
    expect(digest).toMatchObject({
      night,
      badLines: 1,
      rows: [{ job: 'kept-job', owner: 'Kai', firstAt: '2026-11-01T07:30:00-04:00', lastAt: '2026-11-01T07:30:00-04:00' }],
      counts: { ok: 1, retry: 0, fail: 0 },
    });
  });

  it('escapes hostile job, owner, and error strings in HTML while preserving them in JSON', async () => {
    const runsDir = await makeRunsDir();
    const night = '2026-11-02';
    const job = '<script>job()</script>';
    const owner = '<img src=x onerror=alert(1)>';
    const error = '</td><script>error()</script>';
    await writeNight(
      runsDir,
      night,
      JSON.stringify({ at: '2026-11-02T06:00:00Z', job, status: 'fail', owner, error }),
    );
    const app = createApp(configFor(runsDir));

    const htmlResponse = await app.request(`/digest/${night}`);
    const html = await htmlResponse.text();
    const jsonResponse = await app.request(`/api/digest/${night}`);

    expect(htmlResponse.status).toBe(200);
    expect(html).not.toContain('<script>job()</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('</td><script>error()</script>');
    expect(html).toContain('&lt;script&gt;job()&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/td&gt;&lt;script&gt;error()&lt;/script&gt;');
    expect(await jsonResponse.json()).toMatchObject({ rows: [{ job, owner, lastError: error }] });
  });

  it('shows digest links with event counts beside each night on the status board', async () => {
    const runsDir = await makeRunsDir();
    await writeNight(
      runsDir,
      '2026-10-28',
      [
        JSON.stringify({ at: '2026-10-28T08:00:00Z', job: 'one', status: 'ok', owner: 'A' }),
        JSON.stringify({ at: '2026-10-28T08:01:00Z', job: 'two', status: 'retry', owner: 'B' }),
        JSON.stringify({ at: '2026-10-28T08:02:00Z', job: 'two', status: 'fail', owner: 'B' }),
      ].join('\n'),
    );
    await writeNight(
      runsDir,
      '2026-10-29',
      JSON.stringify({ at: '2026-10-29T08:00:00Z', job: 'three', status: 'ok', owner: null }),
    );
    const app = createApp(configFor(runsDir));

    const response = await app.request('/');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('href="/digest/2026-10-28"');
    expect(html).toContain('href="/digest/2026-10-29"');
    const listItems = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
    const nightEntry = listItems.find((item) => item.includes('2026-10-28')) ?? '';
    expect(nightEntry).toContain('ok');
    expect(nightEntry).toContain('retry');
    expect(nightEntry).toContain('fail');
  });
});
