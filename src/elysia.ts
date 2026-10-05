/**
 * jdb/elysia — official ElysiaJS plugin.
 *
 * Injects your JDB instance into the request context so route handlers can
 * do `({ db }) => db.from('products').all()` without manual imports.
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia';
 * import { JDB } from 'jdb';
 * import { jdbPlugin } from 'jdb/elysia';
 *
 * const db = new JDB('./store-data');
 * const app = new Elysia()
 *   .use(jdbPlugin(db))
 *   .get('/products', ({ db }) => db.from('products').all());
 * ```
 */

import { Elysia } from 'elysia';
import type { JDB } from './jdb.js';

/** The context property added to every request by this plugin. */
export interface JdbPluginContext {
  db: JDB;
}

/** Create an Elysia plugin bound to a specific database instance. */
export function jdbPlugin(db: JDB) {
  return new Elysia({ name: 'jdb' }).derive(() => ({ db }));
}

export default jdbPlugin;
