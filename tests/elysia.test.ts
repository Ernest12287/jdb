// @ts-nocheck -- elysia types require Bun's global Request at build time in some setups; runtime is Node 18+ which has Request.
import { describe, it, expect } from 'vitest';
import { Elysia } from 'elysia';
import { t } from '@sinclair/typebox';
import { jdbPlugin } from '../src/elysia.js';
import { JDB } from '../src/jdb.js';
import { tempDb } from './helpers.js';

const ProductSchema = t.Object({
  id: t.String(),
  name: t.String(),
  price: t.Number({ minimum: 0 }),
});

describe('jdb/elysia plugin', () => {
  it('injects db into the request context', async () => {
    const tdb = tempDb();
    tdb.db.collection('products', ProductSchema);
    tdb.db.from('products').insert({ id: 'P-1', name: 'Book', price: 10 });

    const app = new Elysia()
      .use(jdbPlugin(tdb.db))
      .get('/products', ({ db }: any) => db.from('products').all());

    const res = await app.handle(new Request('http://localhost/products'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Book');
    tdb.cleanup();
  });

  it('validates request bodies with TypeBox before inserting', async () => {
    const tdb = tempDb();
    tdb.db.collection('products', ProductSchema);

    const app = new Elysia()
      .use(jdbPlugin(tdb.db))
      .post(
        '/products',
        ({ body, db }: any) => {
          const [p] = db.from('products').insert(body);
          return p;
        },
        { body: ProductSchema },
      );

    const bad = await app.handle(
      new Request('http://localhost/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'X', name: 'bad', price: -1 }),
      }),
    );
    expect(bad.status).toBe(422);

    const good = await app.handle(
      new Request('http://localhost/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'X', name: 'ok', price: 5 }),
      }),
    );
    expect(good.status).toBe(200);
    expect(tdb.db.from('products').count()).toBe(1);
    tdb.cleanup();
  });
});
