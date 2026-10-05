/**
 * jdb — shared type definitions.
 */

/** A minimal structural shape of a (TypeBox-compatible) JSON schema object. */
export interface TSchemaLike {
  type?: string;
  properties?: Record<string, TSchemaLike>;
  required?: string[];
  items?: TSchemaLike;
  [key: string]: unknown;
}

/** Static type inference for schema-like objects (works out-of-the-box with TypeBox). */
export type Static<S> = S extends { static: infer T }
  ? T
  : S extends { type: 'string' }
    ? string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
        : S extends { type: 'null' }
          ? null
          : S extends { type: 'array'; items: infer I }
            ? Array<Static<I>>
            : S extends { type: 'object'; properties: infer P }
              ? { [K in keyof P]: Static<P[K]> }
              : unknown;

/** Options accepted by the JDB constructor. */
export interface JDBConfig {
  /** Create a timestamped backup copy before every write operation. Default: false. */
  autobackup?: boolean;
  /** Directory used to store backups. Default: `<path>/../backups`. */
  backupDir?: string;
  /** Write JSON files with 2-space indentation. Default: true. */
  prettyPrint?: boolean;
}

/** Options accepted by `db.view()`. */
export interface ViewConfig {
  /** Port for the visualizer HTTP server. Default: 3000. */
  port?: number;
  /** Try to open the default browser automatically. Default: false. */
  autoOpen?: boolean;
  /** Disable data mutation from the UI. Default: true. */
  readOnly?: boolean;
}

/** Sortable direction used by `QueryBuilder.order()`. */
export type SortDirection = 'asc' | 'desc';

/** A single validation problem found while checking a record against a schema. */
export interface ValidationErrorDetail {
  path: string;
  message: string;
}

/** Thrown whenever data fails schema validation or a collection invariant is broken. */
export class JDBValidationError extends Error {
  readonly issues: ValidationErrorDetail[];
  constructor(message: string, issues: ValidationErrorDetail[] = []) {
    super(
      issues.length
        ? `${message}: ${issues.map((i) => `${i.path || '<root>'} ${i.message}`).join('; ')}`
        : message,
    );
    this.name = 'JDBValidationError';
    this.issues = issues;
  }
}

/** Thrown when querying/using a collection that was never registered. */
export class JDBCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JDBCollectionError';
  }
}
