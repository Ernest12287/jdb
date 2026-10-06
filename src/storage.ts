/**
 * File-system storage layer for jdb.
 *
 * - One collection == one `<name>.json` file containing a JSON array.
 * - Writes are atomic: data goes to a temp file first, then `rename`d over
 *   the target, so a crash mid-write can never corrupt the database.
 * - Optional backups are taken before every write when `autobackup` is on.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export class Storage {
  readonly dir: string;
  readonly prettyPrint: boolean;
  readonly autobackup: boolean;
  readonly backupDir: string;

  constructor(
    dir: string,
    opts: { prettyPrint?: boolean; autobackup?: boolean; backupDir?: string } = {},
  ) {
    this.dir = resolve(dir);
    this.prettyPrint = opts.prettyPrint ?? true;
    this.autobackup = opts.autobackup ?? false;
    this.backupDir = resolve(opts.backupDir ?? join(this.dir, '..', 'backups'));
    mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path of a collection file. */
  filePath(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  /** True when the collection file exists on disk. */
  exists(name: string): boolean {
    return existsSync(this.filePath(name));
  }

  /** Read a collection. Returns `fallback` when the file does not exist yet. */
  read<T = Record<string, unknown>>(name: string, fallback: T = [] as unknown as T): T {
    const p = this.filePath(name);
    if (!existsSync(p)) return fallback;
    const raw = readFileSync(p, 'utf8').trim();
    if (raw === '') return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(
        `jdb: collection file "${p}" contains invalid JSON and cannot be read (${
          (err as Error).message
        }).`,
      );
    }
  }

  /** Atomically write a collection (temp file + rename), optionally backing up first. */
  write(name: string, data: unknown): void {
    const p = this.filePath(name);
    if (this.autobackup && existsSync(p)) this.backupFile(name);
    const tmp = join(this.dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
    const json = this.prettyPrint ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    try {
      writeFileSync(tmp, json + '\n', 'utf8');
      renameSync(tmp, p); // atomic on same filesystem
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Copy a single collection into the backup directory with a timestamp suffix. */
  backupFile(name: string): string {
    mkdirSync(this.backupDir, { recursive: true });
    const src = this.filePath(name);
    if (!existsSync(src)) return '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(this.backupDir, `${name}.${stamp}.${randomBytes(3).toString('hex')}.json`);
    writeFileSync(dest, readFileSync(src));
    return dest;
  }

  /** List collection names (without the `.json` extension) present on disk. */
  listFiles(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  /** Delete a collection file from disk. */
  remove(name: string): void {
    rmSync(this.filePath(name), { force: true });
  }

  /** Backup every `*.json` collection file in the database folder. */
  backupAll(): string[] {
    mkdirSync(this.backupDir, { recursive: true });
    const files = readdirSync(this.dir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.'),
    );
    return files
      .map((f) => this.backupFile(f.replace(/\.json$/, '')))
      .filter((p): p is string => p !== '');
  }
}
