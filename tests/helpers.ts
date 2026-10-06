/**
 * Shared test helpers: create a throwaway DB folder under /tmp, clean up after.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JDB } from '../src/jdb.js';
import type { TSchemaLike } from '../src/types.js';

export function tempDb(config?: ConstructorParameters<typeof JDB>[1]): {
  db: JDB;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'jdb-test-'));
  const db = new JDB(dir, config);
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.destroy();
      } catch {
        /* noop */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A tiny inline schema DSL so tests don't need TypeBox at runtime. */
export function objectSchema(
  properties: Record<string, TSchemaLike>,
  required?: string[],
): TSchemaLike {
  return {
    type: 'object',
    properties,
    required: required ?? Object.keys(properties),
    additionalProperties: false,
  };
}
