import { describe, it, expect } from 'vitest';
import { tempDb, objectSchema } from './helpers.js';
import { startViewer } from '../src/view.js';

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

describe('visualizer (db.view)', () => {
  it('serves collections and data over HTTP', async () => {
    const t = tempDb();
    const Staff = objectSchema({ id: { type: 'string' }, name: { type: 'string' } });
    t.db.collection('staff', Staff);
    t.db.from('staff').insert({ id: 'S-1', name: 'Alice' });

    const viewer = startViewer(t.db, { port: 0 }); // ephemeral port not supported by our simple server; use fixed high port below
    viewer.close();

    const v2 = startViewer(t.db, { port: 4319 });
    try {
      // wait for listen to bind
      await new Promise((r) => setTimeout(r, 50));
      const cols = await fetchJson('http://localhost:4319/api/collections');
      expect(cols.find((c: any) => c.name === 'staff')).toBeTruthy();
      const rows = await fetchJson('http://localhost:4319/api/data/staff');
      expect(rows[0].name).toBe('Alice');
      const html = await (await fetch('http://localhost:4319/')).text();
      expect(html).toContain('jdb viewer');
    } finally {
      v2.close();
      t.cleanup();
    }
  });
});
