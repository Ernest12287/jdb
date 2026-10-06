/**
 * jdb — public API surface.
 *
 * @example
 * ```ts
 * import { JDB } from 'jdb';
 * import { t } from '@sinclair/typebox';
 *
 * const Product = t.Object({ id: t.String(), name: t.String(), price: t.Number() });
 * const db = new JDB('./data');
 * db.collection('products', Product);
 * db.from('products').insert({ id: 'P-1', name: 'Book', price: 9.99 });
 * ```
 */

export { JDB } from './jdb.js';
export { QueryBuilder } from './query.js';
export type { Filter, Operator, OrderBy, Include, QueryEngine } from './query.js';
export { Storage } from './storage.js';
export { startViewer } from './view.js';
export type { ViewerHandle } from './view.js';
export { validate, validateWithIssues, compile } from './validate.js';
export {
  JDBValidationError,
  JDBCollectionError,
} from './types.js';
export type {
  JDBConfig,
  ViewConfig,
  TSchemaLike,
  SortDirection,
  ValidationErrorDetail,
} from './types.js';

/** Re-export of TypeBox's `Static` inference helper for convenience. */
export type Static<S> = S extends { static: infer T } ? T : never;

import { JDB as _JDB } from './jdb.js';

/** Convenience factory mirroring `new JDB(path, config)`. */
export function jdb(path: string, config?: ConstructorParameters<typeof _JDB>[1]): _JDB {
  return new _JDB(path, config);
}

export default JDBDefault;
declare const JDBDefault: typeof _JDB;
