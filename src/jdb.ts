/**
 * jdb — main engine class.
 *
 * A folder is the database; every registered collection is one `.json` file.
 * Records are cached in memory (with an id index for O(1) lookups) and every
 * mutation is persisted atomically to disk.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { JDBConfig, TSchemaLike, ViewConfig } from './types.js';
import { JDBCollectionError, JDBValidationError } from './types.js';
import { compile, validateWithIssues } from './validate.js';
import { Storage } from './storage.js';
import { QueryBuilder, type QueryEngine } from './query.js';
import { startViewer } from './view.js';

interface CollectionMeta {
  schema?: TSchemaLike;
  validator?: (value: unknown) => boolean;
  autoId: boolean;
  /** Type of the schema's `id` property ('string' | 'number'), if any. */
  idType?: 'string' | 'number';
}

type Row = Record<string, any>;

/** Extract the declared JSON type of a schema's `id` property, if any. */
function idTypeOf(schema?: TSchemaLike): 'string' | 'number' | undefined {
  const t = schema?.properties?.id?.type;
  if (t === 'string') return 'string';
  if (t === 'integer' || t === 'number') return 'number';
  return undefined; // no id property, or a non-numeric/non-string type
}

/** Deep-copy a row so callers never hold live references into the cache. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

export class JDB implements QueryEngine<Row> {
  readonly storage: Storage;
  private collections = new Map<string, CollectionMeta>();
  /** In-memory cache of parsed records per collection. */
  private cache = new Map<string, Row[]>();
  /** id -> index map per collection for fast primary-key lookups. */
  private indexes = new Map<string, Map<string | number, number>>();
  /** Counters backing generateId(), persisted in meta.json. */
  private counters: Record<string, number> = {};
  private metaPath = 'meta';
  private viewer?: ReturnType<typeof startViewer>;
  /** When > 0, mutations accumulate in memory and persist on commit(). */
  private txDepth = 0;
  private dirty = new Set<string>();
  private destroyed = false;

  constructor(path: string, config: JDBConfig = {}) {
    // Fail fast with a clear message if `path` exists but is not a directory.
    if (existsSync(path) && !statSync(path).isDirectory()) {
      throw new JDBCollectionError(
        `jdb: database path "${path}" exists but is not a directory.`,
      );
    }
    this.storage = new Storage(path, {
      prettyPrint: config.prettyPrint ?? true,
      autobackup: config.autobackup ?? false,
      backupDir: config.backupDir,
    });
    this.loadCounters();
    // Auto-discover existing collection files so reopening a DB "just works".
    this.reloadRegistryFromDisk();
  }

  /** Read (or re-read) persisted ID counters from meta.json. */
  private loadCounters(): void {
    const meta = this.storage.read<Record<string, unknown>>(this.metaPath, {});
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const counters = (meta as { counters?: unknown }).counters;
      if (counters && typeof counters === 'object') {
        for (const [k, v] of Object.entries(counters as Record<string, unknown>)) {
          if (typeof v === 'number') this.counters[k] = v;
        }
      }
    }
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new JDBCollectionError('jdb: this instance was destroyed and can no longer be used.');
    }
  }

  // ------------------------------------------------------------- registry

  /** Register (or re-register) a collection backed by `<name>.json`. */
  collection<T extends Row = Row>(name: string, schema?: TSchemaLike): this {
    this.assertAlive();
    this.assertValidName(name);
    const idType = idTypeOf(schema);
    // Auto-id whenever the collection has no *required* `id`: either there is
    // no schema, or `id` is absent from `required`. The generated value's type
    // follows the declared id type (see buildInsert), so numeric ids work too.
    const autoId = !schema || !schema.required?.includes('id');
    const meta: CollectionMeta = {
      schema,
      validator: schema ? compile(schema) : undefined,
      autoId,
      idType,
    };
    this.assertNoCaseCollision(name);
    this.collections.set(name, meta);
    if (!this.storage.exists(name)) this.storage.write(name, []);
    this.load(name);
    return this;
  }

  /** Names of all registered/discovered collections. */
  listCollections(): string[] {
    return [...this.collections.keys()];
  }

  hasCollection(name: string): boolean {
    return this.collections.has(name);
  }

  /** The schema registered for a collection (if any). */
  getSchema(name: string): TSchemaLike | undefined {
    return this.getMeta(name).schema;
  }

  /** Remove a collection from the registry; optionally delete its file and counter too. */
  drop(name: string, deleteFile = false): void {
    this.assertAlive();
    this.getMeta(name);
    this.collections.delete(name);
    this.cache.delete(name);
    this.indexes.delete(name);
    this.dirty.delete(name);
    if (deleteFile) {
      this.storage.remove(name);
      // Counter only makes sense while the collection exists; clean it up.
      delete this.counters[name.toUpperCase()];
      this.persistMeta();
    }
  }

  // ---------------------------------------------------------------- query

  /** Start a chainable query on a collection. */
  from(name: string): QueryBuilder<Row> {
    this.assertAlive();
    this.getMeta(name); // throws when unknown
    return new QueryBuilder<Row>(this, name);
  }

  // ------------------------------------------------------------ ids/meta

  /** Monotonic, sortable id like `PROD-0001`; counters persist in meta.json. */
  generateId(prefix = 'ID'): string {
    this.assertAlive();
    const next = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = next;
    this.persistMeta();
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  /** Random UUID (useful when you prefer non-guessable keys). */
  uuid(): string {
    return randomUUID();
  }

  /** Flush caches to disk, close the viewer, and mark the instance dead. */
  destroy(): void {
    if (this.destroyed) return;
    for (const name of this.collections.keys()) this.flush(name);
    this.persistMeta();
    this.viewer?.close();
    this.viewer = undefined;
    this.destroyed = true;
  }

  /** Copy every collection file into the backup directory. Returns backup paths. */
  backup(): string[] {
    this.assertAlive();
    return this.storage.backupAll();
  }

  /**
   * Re-read everything from disk: refreshes ID counters from meta.json,
   * discards the in-memory cache/indexes and re-discovers collection files.
   * The next access to each collection loads its current on-disk contents,
   * so external edits made by other processes become visible.
   */
  reload(): void {
    this.assertAlive();
    this.cache.clear();
    this.indexes.clear();
    this.dirty.clear();
    this.counters = {};
    this.loadCounters();
    this.reloadRegistryFromDisk();
  }

  // --------------------------------------------------------- transactions

  /**
   * Batch many mutations into a single write per touched collection.
   * Inside the callback nothing hits disk; on success every dirty collection
   * is persisted once (and counters are written once). If the callback throws,
   * all uncommitted changes are rolled back from disk and rethrown.
   */
  transaction<T>(fn: (db: this) => T): T {
    this.assertAlive();
    const inTx = this.txDepth > 0;
    this.txDepth++;
    try {
      const result = fn(this);
      if (!inTx) this.commit();
      return result;
    } catch (err) {
      if (!inTx) this.rollback();
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /** Persist every collection modified inside the current transaction. @internal */
  private commit(): void {
    for (const name of this.dirty) this.flush(name);
    this.dirty.clear();
    this.persistMeta();
  }

  /** Discard uncommitted transaction changes by reloading from disk. @internal */
  private rollback(): void {
    for (const name of this.dirty) {
      this.cache.delete(name);
      this.indexes.delete(name);
    }
    this.dirty.clear();
  }

  // ------------------------------------------------------------- viewer

  /** Launch the built-in read-only data visualizer HTTP server. */
  view(config: ViewConfig = {}): { url: string; close: () => void } {
    this.viewer = startViewer(this, config);
    return this.viewer;
  }

  // ------------------------------------------- QueryEngine implementation

  /** @internal */
  getRecords(name: string): Row[] {
    this.assertAlive();
    this.getMeta(name);
    let rows = this.cache.get(name);
    if (!rows) rows = this.load(name);
    return rows;
  }

  /** @internal */
  setRecords(name: string, records: Row[]): void {
    this.assertAlive();
    this.getMeta(name);
    this.cache.set(name, records);
    this.reindex(name);
    // Inside a transaction defer the disk write; commit() persists once.
    if (this.txDepth > 0) this.dirty.add(name);
    else this.flush(name);
  }

  /** @internal */
  validateRecord(name: string, record: unknown): void {
    const meta = this.getMeta(name);
    if (!meta.schema || !meta.validator) return;
    if (!meta.validator(record)) {
      const issues = validateWithIssues(meta.schema, record);
      throw new JDBValidationError(
        `jdb: record failed validation for collection "${name}"`,
        issues,
      );
    }
  }

  /** @internal */
  prepareInsert(name: string, data: Row): Row {
    return this.buildInsert(this.getMeta(name), name, data);
  }

  /** Shared insert-preparation used by both the query builder and insertMany(). */
  private buildInsert(meta: CollectionMeta, name: string, data: Row): Row {
    const record: Row = clone(data);
    if (meta.autoId && record.id === undefined) {
      // String ids come from the sortable counter; numeric ids are seeded
      // from the current max so they stay valid against the schema. Anything
      // else falls back to a UUID so we never inject an invalid id type.
      if (meta.idType === 'number') {
        const rows = this.cache.get(name) ?? [];
        const max = rows.reduce((m, r) => (typeof r.id === 'number' && r.id > m ? r.id : m), 0);
        record.id = max + 1;
      } else {
        record.id = this.generateId(name.toUpperCase());
      }
    }
    return record;
  }

  // -------------------------------------------------------------- helpers

  private assertValidName(name: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new JDBCollectionError(
        `jdb: invalid collection name "${name}" (allowed: letters, digits, "-", "_").`,
      );
    }
  }

  /**
   * On case-insensitive filesystems (macOS/Windows defaults) `Products` and
   * `products` would map to the same file. Refuse such collisions up front so
   * behavior is identical on every platform.
   */
  private assertNoCaseCollision(name: string): void {
    for (const existing of this.collections.keys()) {
      if (existing !== name && existing.toLowerCase() === name.toLowerCase()) {
        throw new JDBCollectionError(
          `jdb: collection "${name}" collides with existing "${existing}" ` +
            `(case-insensitive filesystems treat them as the same file).`,
        );
      }
    }
  }

  private getMeta(name: string): CollectionMeta {
    const meta = this.collections.get(name);
    if (!meta) {
      throw new JDBCollectionError(
        `jdb: unknown collection "${name}". Register it first with db.collection("${name}", schema).`,
      );
    }
    return meta;
  }

  private load(name: string): Row[] {
    const raw = this.storage.read<unknown>(name, []);
    const rows: Row[] = Array.isArray(raw) ? (raw as Row[]) : [];
    this.cache.set(name, rows);
    this.reindex(name);
    return rows;
  }

  private reindex(name: string): void {
    const rows = this.cache.get(name) ?? [];
    const map = new Map<string | number, number>();
    rows.forEach((r, i) => {
      if (typeof r.id === 'string' || typeof r.id === 'number') map.set(r.id, i);
    });
    this.indexes.set(name, map);
  }

  /** Fast primary-key lookup using the in-memory index. Returns a defensive copy. */
  findById(name: string, id: string | number): Row | null {
    this.getRecords(name);
    const idx = this.indexes.get(name)?.get(id);
    if (idx === undefined) return null;
    const row = this.cache.get(name)?.[idx];
    return row ? clone(row) : null;
  }

  /**
   * Read a collection from disk and return defensive copies of its rows,
   * so callers can never mutate the engine's internal cache by reference.
   */
  all(name: string): Row[] {
    return this.getRecords(name).map(clone);
  }

  /** @internal Write rows to the cache; pass `validate` only for full-collection writes. */
  private replaceRecords(name: string, rows: Row[], validate = false): void {
    if (validate) for (const r of rows) this.validateRecord(name, r);
    this.setRecords(name, rows);
  }

  /**
   * Replace an entire collection atomically (single write + single reindex).
   * Every row is validated against the schema first; on failure nothing is written.
   */
  replaceAll(name: string, records: Row[]): void {
    this.replaceRecords(name, records.map(clone), true);
  }

  /** Insert many records with ONE disk write and ONE reindex (batch fast-path). */
  insertMany(name: string, items: Row[]): Row[] {
    this.assertAlive();
    const meta = this.getMeta(name);
    const records = this.getRecords(name).map(clone);
    const inserted: Row[] = [];
    for (const item of items) {
      const record = this.buildInsert(meta, name, item);
      this.validateRecord(name, record);
      if (record.id !== undefined && records.some((r) => r.id === record.id)) {
        throw new JDBValidationError(
          `jdb: duplicate id "${String(record.id)}" in collection "${name}".`,
        );
      }
      records.push(record);
      inserted.push(record);
    }
    this.setRecords(name, records);
    return inserted.map(clone);
  }

  /** Update every row whose id matches one of `patches`; ONE disk write total. */
  updateMany(name: string, patches: Array<{ id: string | number } & Row>): Row[] {
    this.assertAlive();
    this.getMeta(name);
    const byId = new Map(patches.map((p) => [p.id, p]));
    const records = this.getRecords(name).map((r0) => {
      const r = clone(r0);
      const patch = r.id !== undefined ? byId.get(r.id) : undefined;
      if (!patch) return r0;
      const merged = { ...clone(r), ...clone(patch) };
      this.validateRecord(name, merged);
      return merged;
    });
    this.setRecords(name, records);
    return patches.map((p) => clone(byId.get(p.id) as Row)).filter((r) =>
      records.some((x) => x.id === r.id),
    );
  }

  private flush(name: string): void {
    this.storage.write(name, this.cache.get(name) ?? []);
  }

  private persistMeta(): void {
    this.storage.write(this.metaPath, { counters: this.counters, version: 1 });
  }

  private reloadRegistryFromDisk(): void {
    for (const f of this.storage.listFiles()) {
      if (f === this.metaPath || this.collections.has(f)) continue;
      // Discovered file without explicit registration: allow schema-less usage.
      const idType = undefined;
      this.collections.set(f, { autoId: true, idType });
    }
  }
}
