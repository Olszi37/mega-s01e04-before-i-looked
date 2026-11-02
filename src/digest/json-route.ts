import { Hono } from 'hono';
import type { RigConfig } from '../config.js';
import { readNight } from './reader.js';

export function registerDigestJson(app: Hono, config: RigConfig): void {
  app.get('/api/digest/:night', (c) => {
    const digest = readNight(config.runsDir, c.req.param('night'));

    if (digest === null) {
      return c.json({ error: 'Night not found' }, 404);
    }

    return c.json(digest);
  });
}
