/**
 * jdb — main engine class.
 *
 * A folder is the database; every registered collection is one `.json` file.
 * Records are cached in memory (with an id index for O(1) lookups) and every
 * mutation is persisted atomically to disk.
 */

import { randomUUID } from 'node:crypto';
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
}

type Row = Record<string, any>;

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

  constructor(path: string, config: JDBConfig = {}) {
    this.storage = new Storage(path, {
      prettyPrint: config.prettyPrint ?? true,
      autobackup: config.autobackup ?? false,
      backupDir: config.backupDir,
    });
    // Load persisted ID counters if meta.json exists.
    const meta = this.storage.read<Record<string, unknown>>(this.metaPath, {});
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const counters = (meta as { counters?: unknown }).counters;
      if (counters && typeof counters === 'object') {
        for (const [k, v] of Object.entries(counters as Record<string, unknown>)) {
          if (typeof v === 'number') this.counters[k] = v;
        }
      }
    }
    // Auto-discover existing collection files so reopening a DB "just works".
    this.reloadRegistryFromDisk();
  }

  // ------------------------------------------------------------- registry

  /** Register (or re-register) a collection backed by `<name>.json`. */
  collection<T extends Row = Row>(name: string, schema?: TSchemaLike): this {
    this.assertValidName(name);
    const meta: CollectionMeta = {
      schema,
      validator: schema ? compile(schema) : undefined,
      autoId: schema ? Boolean((schema.properties as Row | undefined)?.id) : false,
    };
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

  /** Remove a collection from the registry; optionally delete its file too. */
  drop(name: string, deleteFile = false): void {
    this.getMeta(name);
    this.collections.delete(name);
    this.cache.delete(name);
    this.indexes.delete(name);
    if (deleteFile) this.storage.remove(name);
  }

  // ---------------------------------------------------------------- query

  /** Start a chainable query on a collection. */
  from(name: string): QueryBuilder<Row> {
    this.getMeta(name); // throws when unknown
    return new QueryBuilder<Row>(this, name);
  }

  // ------------------------------------------------------------ ids/meta

  /** Monotonic, sortable id like `PROD-0001`; counters persist in meta.json. */
  generateId(prefix = 'ID'): string {
    const next = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = next;
    this.persistMeta();
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  /** Random UUID (useful when you prefer non-guessable keys). */
  uuid(): string {
    return randomUUID();
  }

  /** Flush caches to disk (also happens automatically after each write). */
  destroy(): void {
    for (const name of this.collections.keys()) this.flush(name);
    this.persistMeta();
    this.viewer?.close();
    this.viewer = undefined;
  }

  /** Copy every collection file into the backup directory. Returns backup paths. */
  backup(): string[] {
    return this.storage.backupAll();
  }

  /** Re-read all collection files from disk, discarding the in-memory cache. */
  reload(): void {
    this.cache.clear();
    this.indexes.clear();
    this.reloadRegistryFromDisk();
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
    this.getMeta(name);
    let rows = this.cache.get(name);
    if (!rows) rows = this.load(name);
    return rows;
  }

  /** @internal */
  setRecords(name: string, records: Row[]): void {
    this.getMeta(name);
    this.cache.set(name, records);
    this.reindex(name);
    this.flush(name);
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
    const meta = this.getMeta(name);
    const record: Row = { ...data };
    if (meta.autoId && record.id === undefined) record.id = this.generateId(name.toUpperCase());
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

  /** Fast primary-key lookup using the in-memory index. */
  findById(name: string, id: string | number): Row | null {
    this.getRecords(name);
    const idx = this.indexes.get(name)?.get(id);
    if (idx === undefined) return null;
    return this.cache.get(name)?.[idx] ?? null;
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
      this.collections.set(f, { autoId: true });
    }
  }
}
