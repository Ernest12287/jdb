# jdb API Reference 📚

Complete reference for the `jdb` library, its query builder, Elysia plugin, and built-in visualizer.

---

## 1. Core Class: `JDB`

The main entry point. Manages the database folder, file I/O, and global configuration.

### Constructor
```typescript
new JDB(path: string, config?: JDBConfig)
```

**Parameters:**
*   `path` (`string`): The directory path where JSON files will be stored.
*   `config` (`JDBConfig`, optional):
    *   `autobackup` (`boolean`): If `true`, creates a backup before every write. Default: `false`.
    *   `backupDir` (`string`): Path to store backups. Default: `'./backups'`.
    *   `prettyPrint` (`boolean`): If `true`, saves JSON with indentation. Default: `true`.

### Methods

#### `collection(name, schema)`
Registers a table (JSON file) and enforces a TypeBox schema.
```typescript
db.collection('products', ProductSchema);
```
*   **`name`** (`string`): The name of the collection (becomes `name.json`).
*   **`schema`** (`TSchema`): A TypeBox schema object.

#### `from(name)`
Starts a query chain on a specific collection. Returns a `QueryBuilder`.
```typescript
const query = db.from('products');
```

#### `generateId(prefix)`
Generates a unique, sortable ID using an internal counter stored in `meta.json`.
```typescript
const id = db.generateId('PROD'); // Returns "PROD-0001", then "PROD-0002"...
```

#### `view(config?)`
Starts the built-in data visualizer server.
```typescript
db.view({ port: 3000, autoOpen: true });
```
*   **`config`** (`ViewConfig`, optional):
    *   `port` (`number`): Port to run the viewer. Default: `3000`.
    *   `autoOpen` (`boolean`): Open browser automatically. Default: `false`.
    *   `readOnly` (`boolean`): Disable UI editing. Default: `true`.

#### `backup()`
Manually triggers a backup of all collections to `backupDir`.

#### `destroy()`
Flushes all in-memory changes to disk and closes file handles.

---

## 2. Query Builder: `QueryBuilder<T>`

Returned by `db.from()`. Supports method chaining for filtering, sorting, and mutation.

### Filtering & Selection

| Method | Signature | Description |
| :--- | :--- | :--- |
| **`select`** | `(fields: string[]) => this` | Limits returned fields. Default is `'*'` (all). |
| **`eq`** | `(key: keyof T, value: any) => this` | Equal to. |
| **`neq`** | `(key: keyof T, value: any) => this` | Not equal to. |
| **`gt`** | `(key: keyof T, value: number) => this` | Greater than. |
| **`lt`** | `(key: keyof T, value: number) => this` | Less than. |
| **`gte`** | `(key: keyof T, value: number) => this` | Greater than or equal. |
| **`lte`** | `(key: keyof T, value: number) => this` | Less than or equal. |
| **`like`** | `(key: keyof T, pattern: string) => this` | Case-insensitive substring match. |
| **`in`** | `(key: keyof T, values: any[]) => this` | Matches any value in the array. |
| **`order`** | `(key: keyof T, dir: 'asc'\|'desc') => this` | Sorts results. |
| **`limit`** | `(count: number) => this` | Limits number of results. |
| **`offset`** | `(count: number) => this` | Skips results (pagination). |

### Data Retrieval

| Method | Signature | Description |
| :--- | :--- | :--- |
| **`all`** | `() => T[]` | Returns all matching records. |
| **`first`** | `() => T \| null` | Returns the first matching record or `null`. |
| **`count`** | `() => number` | Returns the number of matching records. |

### Data Mutation (Write Operations)

| Method | Signature | Description |
| :--- | :--- | :--- |
| **`insert`** | `(data: Partial<T>) => T` | Adds a new record. Auto-generates `id` if missing. |
| **`update`** | `(data: Partial<T>) => T[]` | Updates matching records. Returns updated records. |
| **`delete`** | `() => void` | Deletes matching records. |
| **`upsert`** | `(data: Partial<T>, key: keyof T) => T` | Inserts if not exists, updates if exists. |

### Relational Joins

| Method | Signature | Description |
| :--- | :--- | :--- |
| **`include`** | `(col: string, fk: string) => this` | Joins another collection. Fetches related data and nests it. |

---

## 3. Elysia Plugin: `jdbPlugin`

Injects the `db` instance into the Elysia request context.

### Usage
```typescript
import { jdbPlugin } from 'jdb/elysia';

app.use(jdbPlugin(db));
```

### Context Property
*   **`db`**: The initialized `JDB` instance, available in all route handlers.

---

## 4. Visualizer: `jdb.view()`

A lightweight, read-only dashboard for your data.

### Configuration
```typescript
db.view({
  port: 3000,      // Port for the UI
  autoOpen: true,  // Open browser on start
  readOnly: true   // Prevent UI edits
});
```

### Features
*   **Live Grid**: Real-time view of all JSON collections.
*   **Schema Inspector**: Shows TypeBox definitions for each table.
*   **Relationship Mapping**: Highlights links between tables (e.g., `staff_id`).