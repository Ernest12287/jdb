/**
 * Supabase-like chainable query builder.
 *
 * Filters accumulate through `eq/neq/gt/lt/gte/lte/like/in/order/limit/offset/include`,
 * then a terminal method (`all`, `first`, `count`, `insert`, `update`, `delete`,
 * `upsert`) executes against the in-memory snapshot of the collection and
 * persists atomically when a mutation occurs.
 */

import type { SortDirection } from './types.js';
import { JDBValidationError } from './types.js';

export type Operator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'like'
  | 'in';

export interface Filter {
  op: Operator;
  key: string;
  value: unknown;
}

export interface OrderBy {
  key: string;
  dir: SortDirection;
}

export interface Include {
  collection: string;
  foreignKey: string;
  alias?: string;
}

/** The subset of JDB the builder needs — keeps this module decoupled/testable. */
export interface QueryEngine<T extends Record<string, any> = Record<string, any>> {
  getRecords(name: string): T[];
  setRecords(name: string, records: T[]): void;
  validateRecord(name: string, record: unknown): void;
  hasCollection(name: string): boolean;
  /** Fill defaults / auto-generate ids before validating an insert. */
  prepareInsert(name: string, data: Partial<T>): T;
}

function getPath(obj: Record<string, unknown>, key: string): unknown {
  if (!key.includes('.')) return obj[key];
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function matchesFilter(record: Record<string, unknown>, f: Filter): boolean {
  const v = getPath(record, f.key);
  switch (f.op) {
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== f.value;
    case 'gt':
      return typeof v === 'number' && typeof f.value === 'number' && v > f.value;
    case 'lt':
      return typeof v === 'number' && typeof f.value === 'number' && v < f.value;
    case 'gte':
      return typeof v === 'number' && typeof f.value === 'number' && v >= f.value;
    case 'lte':
      return typeof v === 'number' && typeof f.value === 'number' && v <= f.value;
    case 'like': {
      if (typeof v !== 'string' || typeof f.value !== 'string') return false;
      // SQL-ish pattern: % = any chars, _ = single char. Plain substring otherwise.
      const pattern = f.value;
      if (pattern.includes('%') || pattern.includes('_')) {
        const re = new RegExp(
          '^' +
            pattern
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/%/g, '.*')
              .replace(/_/g, '.') +
            '$',
          'i',
        );
        return re.test(v);
      }
      return v.toLowerCase().includes(pattern.toLowerCase());
    }
    case 'in':
      return Array.isArray(f.value) && f.value.includes(v);
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

export class QueryBuilder<T extends Record<string, any> = Record<string, any>> {
  private readonly engine: QueryEngine<T>;
  readonly collection: string;
  private filters: Filter[] = [];
  private orderBy: OrderBy[] = [];
  private limitCount?: number;
  private offsetCount?: number;
  private selectFields?: string[];
  private includes: Include[] = [];

  constructor(engine: QueryEngine<T>, collection: string) {
    this.engine = engine;
    this.collection = collection;
  }

  // ---------------------------------------------------------------- selection

  /** Limit which fields are returned (applies after joins). */
  select(fields: string[]): this {
    this.selectFields = [...fields];
    return this;
  }

  // --------------------------------------------------------------- filtering

  eq(key: keyof T & string, value: unknown): this {
    this.filters.push({ op: 'eq', key, value });
    return this;
  }
  neq(key: keyof T & string, value: unknown): this {
    this.filters.push({ op: 'neq', key, value });
    return this;
  }
  gt(key: keyof T & string, value: number): this {
    this.filters.push({ op: 'gt', key, value });
    return this;
  }
  lt(key: keyof T & string, value: number): this {
    this.filters.push({ op: 'lt', key, value });
    return this;
  }
  gte(key: keyof T & string, value: number): this {
    this.filters.push({ op: 'gte', key, value });
    return this;
  }
  lte(key: keyof T & string, value: number): this {
    this.filters.push({ op: 'lte', key, value });
    return this;
  }
  like(key: keyof T & string, pattern: string): this {
    this.filters.push({ op: 'like', key, value: pattern });
    return this;
  }
  in(key: keyof T & string, values: unknown[]): this {
    this.filters.push({ op: 'in', key, value: values });
    return this;
  }

  // ------------------------------------------------------------ ordering etc

  order(key: keyof T & string, dir: SortDirection = 'asc'): this {
    this.orderBy.push({ key, dir });
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  /** Join another collection: nests the related record(s) under `as` (default: collection name). */
  include(col: string, fk: keyof T & string, as?: string): this {
    if (!this.engine.hasCollection(col)) {
      throw new JDBValidationError(`jdb: cannot include unknown collection "${col}".`);
    }
    this.includes.push({ collection: col, foreignKey: fk, alias: as });
    return this;
  }

  // ------------------------------------------------------------- execution

  /** All records matching the accumulated filters. */
  all(): T[] {
    let rows: T[] = this.engine.getRecords(this.collection).filter((r) =>
      this.filters.every((f) => matchesFilter(r as Record<string, unknown>, f)),
    );

    if (this.orderBy.length) {
      rows = [...rows].sort((a, b) => {
        for (const o of this.orderBy) {
          const cmp = compareValues(
            getPath(a as Record<string, unknown>, o.key),
            getPath(b as Record<string, unknown>, o.key),
          );
          if (cmp !== 0) return o.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }

    // Joins happen before slicing so field projection stays cheap.
    rows = rows.map((r) => this.applyIncludes(r as Record<string, unknown>) as T);

    if (this.offsetCount !== undefined) rows = rows.slice(this.offsetCount);
    if (this.limitCount !== undefined) rows = rows.slice(0, this.limitCount);
    if (this.selectFields) {
      rows = rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const f of this.selectFields!) out[f] = (r as Record<string, unknown>)[f];
        return out as T;
      });
    }
    return rows;
  }

  /** First matching record or `null`. */
  first(): T | null {
    return this.limit(1).all()[0] ?? null;
  }

  /** Number of matching records (ignores limit/offset). */
  count(): number {
    return this.engine
      .getRecords(this.collection)
      .filter((r) => this.filters.every((f) => matchesFilter(r as Record<string, unknown>, f)))
      .length;
  }

  exists(): boolean {
    return this.count() > 0;
  }

  // -------------------------------------------------------------- mutations

  /** Insert one record (or an array of records). Validates against the schema. */
  insert(data: Partial<T> | Partial<T>[]): T[] {
    const items = Array.isArray(data) ? data : [data];
    const records = [...this.engine.getRecords(this.collection)] as T[];
    const inserted: T[] = [];
    for (const item of items) {
      const record = this.engine.prepareInsert(this.collection, item) as T;
      this.engine.validateRecord(this.collection, record);
      if ('id' in record && record.id !== undefined) {
        if (records.some((r) => (r as Record<string, unknown>).id === record.id)) {
          throw new JDBValidationError(
            `jdb: duplicate id "${String(record.id)}" in collection "${this.collection}".`,
          );
        }
      }
      records.push(record);
      inserted.push(record);
    }
    this.engine.setRecords(this.collection, records);
    return inserted;
  }

  /** Update every record matching the current filters. Returns updated records. */
  update(data: Partial<T>): T[] {
    const records = [...this.engine.getRecords(this.collection)] as T[];
    const updated: T[] = [];
    const next = records.map((r) => {
      if (!this.filters.every((f) => matchesFilter(r as Record<string, unknown>, f))) return r;
      const merged = { ...r, ...data } as T;
      this.engine.validateRecord(this.collection, merged);
      updated.push(merged);
      return merged;
    });
    this.engine.setRecords(this.collection, next);
    return updated;
  }

  /** Delete every record matching the current filters. Returns deleted records. */
  delete(): T[] {
    const records = this.engine.getRecords(this.collection) as T[];
    const keep: T[] = [];
    const removed: T[] = [];
    for (const r of records) {
      if (this.filters.every((f) => matchesFilter(r as Record<string, unknown>, f))) removed.push(r);
      else keep.push(r);
    }
    if (removed.length) this.engine.setRecords(this.collection, keep);
    return removed;
  }

  /** Insert when no record with `key === data[key]` exists, otherwise update it. */
  upsert(data: Partial<T>, key: keyof T & string = 'id' as keyof T & string): T {
    const existing = this.eq(key, (data as Record<string, unknown>)[key]).first();
    if (existing) {
      return this.eq(key, (data as Record<string, unknown>)[key]).update(data)[0] as T;
    }
    return this.insert(data)[0] as T;
  }

  // ---------------------------------------------------------------- internals

  private applyIncludes(row: Record<string, unknown>): Record<string, unknown> {
    if (!this.includes.length) return row;
    const out: Record<string, unknown> = { ...row };
    for (const inc of this.includes) {
      const alias = inc.alias ?? inc.collection;
      const fkValue = out[inc.foreignKey];
      const related = this.engine
        .getRecords(inc.collection)
        .filter((r) => (r as Record<string, unknown>).id === fkValue);
      out[alias] = related.length === 1 ? related[0] : related.length > 1 ? related : null;
    }
    return out;
  }
}
