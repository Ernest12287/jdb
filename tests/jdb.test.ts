import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDb, objectSchema } from './helpers.js';
import { JDBValidationError, JDBCollectionError } from '../src/types.js';
import { JDB } from '../src/jdb.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const Product = objectSchema({
  id: { type: 'string' },
  name: { type: 'string' },
  price: { type: 'number', minimum: 0 },
  stock: { type: 'integer', minimum: 0 },
});

function seeded() {
  const t = tempDb();
  cleanup = t.cleanup;
  t.db.collection('products', Product);
  t.db.from('products').insert([
    { id: 'P-1', name: 'The Great Gatsby', price: 12.5, stock: 50 },
    { id: 'P-2', name: 'Whole Milk 1L', price: 3.99, stock: 100 },
    { id: 'P-3', name: 'Dune', price: 18, stock: 0 },
  ]);
  return t;
}

describe('JDB core', () => {
  it('creates a json file per collection on registration', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    t.db.collection('products', Product);
    expect(existsSync(join(t.dir, 'products.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(t.dir, 'products.json'), 'utf8'))).toEqual([]);
  });

  it('rejects unknown collections', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    expect(() => t.db.from('nope')).toThrow(JDBCollectionError);
  });

  it('rejects invalid collection names', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    expect(() => t.db.collection('../evil', Product)).toThrow(JDBCollectionError);
  });

  it('validates inserts against the schema', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    t.db.collection('products', Product);
    expect(() =>
      t.db.from('products').insert({ id: 'X', name: 'bad', price: -1, stock: 2 }),
    ).toThrow(JDBValidationError);
    expect(() =>
      t.db.from('products').insert({ id: 'X', name: 'bad', price: 1, stock: 1.5 }),
    ).toThrow(JDBValidationError);
  });

  it('persists writes atomically to disk', () => {
    const t = seeded();
    const raw = JSON.parse(readFileSync(join(t.dir, 'products.json'), 'utf8'));
    expect(raw).toHaveLength(3);
    expect(raw[0].name).toBe('The Great Gatsby');
  });

  it('reopens an existing folder and auto-discovers collections', () => {
    const t = seeded();
    const dir = t.dir;
    cleanup = null;
    t.db.destroy();

    const db2 = new JDB(dir);
    expect(db2.hasCollection('products')).toBe(true);
    expect(db2.from('products').count()).toBe(3);
    db2.destroy();
    t.cleanup();
    cleanup = null;
  });

  it('generateId is monotonic, prefixed and persisted in meta.json', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    expect(t.db.generateId('S')).toBe('S-0001');
    expect(t.db.generateId('S')).toBe('S-0002');
    expect(t.db.generateId('PROD')).toBe('PROD-0001');
    const meta = JSON.parse(readFileSync(join(t.dir, 'meta.json'), 'utf8'));
    expect(meta.counters.S).toBe(2);
  });

  it('autobackup creates backup files before writes', () => {
    const dirBackup = join(tempDb().dir, '..', 'jdb-backups-test');
    const t = tempDb({ autobackup: true, backupDir: dirBackup });
    cleanup = t.cleanup;
    t.db.collection('products', Product);
    t.db.from('products').insert({ id: 'P-1', name: 'A', price: 1, stock: 1 });
    t.db.from('products').update({ stock: 2 }).eq('id', 'P-1');
    const backups = t.db.backup();
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe('QueryBuilder filtering & retrieval', () => {
  it('eq / neq / gt / gte / lt / lte', () => {
    const t = seeded();
    expect(t.db.from('products').eq('name', 'Dune').all()).toHaveLength(1);
    expect(t.db.from('products').neq('id', 'P-1').all()).toHaveLength(2);
    expect(t.db.from('products').gt('price', 12.5).all()).toHaveLength(1);
    expect(t.db.from('products').gte('price', 12.5).all()).toHaveLength(2);
    expect(t.db.from('products').lt('stock', 50).all()).toHaveLength(1);
    expect(t.db.from('products').lte('stock', 50).all()).toHaveLength(2);
  });

  it('like does case-insensitive substring and SQL wildcards', () => {
    const t = seeded();
    expect(t.db.from('products').like('name', 'gatsby').all()).toHaveLength(1);
    expect(t.db.from('products').like('name', '%MILK%').all()).toHaveLength(1);
    expect(t.db.from('products').like('name', 'Du_e').all()).toHaveLength(1);
  });

  it('in matches any of the values', () => {
    const t = seeded();
    expect(t.db.from('products').in('id', ['P-1', 'P-3']).all()).toHaveLength(2);
  });

  it('order + limit + offset paginate', () => {
    const t = seeded();
    const page = t.db.from('products').order('price', 'desc').limit(2).offset(1).all();
    expect(page.map((p: any) => p.id)).toEqual(['P-1', 'P-2']);
  });

  it('select projects only requested fields', () => {
    const t = seeded();
    const rows = t.db.from('products').select(['id', 'price']).order('id').all();
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'price']);
  });

  it('first returns null when nothing matches', () => {
    const t = seeded();
    expect(t.db.from('products').eq('id', 'ZZZ').first()).toBeNull();
  });

  it('findById uses the primary key index', () => {
    const t = seeded();
    expect(t.db.findById('products', 'P-2')?.name).toBe('Whole Milk 1L');
    expect(t.db.findById('products', 'missing')).toBeNull();
  });
});

describe('QueryBuilder mutations', () => {
  it('insert returns inserted records and auto-generates ids when missing', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    // Schema without required id -> autoId path via optional id property
    t.db.collection('logs', objectSchema({ msg: { type: 'string' } }, []));
    const [row] = t.db.from('logs').insert({ msg: 'hello' });
    expect(row.id).toMatch(/^LOGS-\d{4}$/);
  });

  it('update merges fields into matching rows and validates the result', () => {
    const t = seeded();
    const updated = t.db.from('products').update({ stock: 48 }).eq('id', 'P-1');
    expect(updated[0].stock).toBe(48);
    expect(t.db.from('products').eq('id', 'P-1').first()?.stock).toBe(48);
    // other rows untouched
    expect(t.db.from('products').eq('id', 'P-2').first()?.stock).toBe(100);
    // invalid update rejected
    expect(() => t.db.from('products').update({ price: -5 }).eq('id', 'P-1')).toThrow(
      JDBValidationError,
    );
  });

  it('delete removes matching rows and returns them', () => {
    const t = seeded();
    const removed = t.db.from('products').eq('id', 'P-3').delete();
    expect(removed).toHaveLength(1);
    expect(t.db.from('products').count()).toBe(2);
  });

  it('duplicate ids are rejected', () => {
    const t = seeded();
    expect(() =>
      t.db.from('products').insert({ id: 'P-1', name: 'dupe', price: 1, stock: 1 }),
    ).toThrow(JDBValidationError);
  });

  it('upsert inserts then updates', () => {
    const t = seeded();
    t.db.from('products').upsert({ id: 'P-9', name: 'New', price: 5, stock: 5 });
    expect(t.db.from('products').count()).toBe(4);
    t.db.from('products').upsert({ id: 'P-9', name: 'Renamed', price: 6, stock: 5 });
    expect(t.db.from('products').count()).toBe(4);
    expect(t.db.from('products').eq('id', 'P-9').first()?.name).toBe('Renamed');
  });
});

describe('Relational joins (.include)', () => {
  it('nests related records across collections', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    const Staff = objectSchema({ id: { type: 'string' }, name: { type: 'string' } });
    const Txn = objectSchema({
      id: { type: 'string' },
      staff_id: { type: 'string' },
      amount: { type: 'number' },
    });
    t.db.collection('staff', Staff);
    t.db.collection('transactions', Txn);
    t.db.from('staff').insert({ id: 'S-1', name: 'Alice' });
    t.db.from('transactions').insert({ id: 'T-1', staff_id: 'S-1', amount: 20 });

    const row: any = t.db.from('transactions').eq('id', 'T-1').include('staff', 'staff_id').first();
    expect(row.staff).toEqual({ id: 'S-1', name: 'Alice' });
  });

  it('supports aliases and dangling foreign keys', () => {
    const t = tempDb();
    cleanup = t.cleanup;
    t.db.collection('staff', objectSchema({ id: { type: 'string' }, name: { type: 'string' } }));
    t.db.collection('txn', objectSchema({ id: { type: 'string' }, staff_id: { type: 'string' } }));
    t.db.from('txn').insert({ id: 'T-1', staff_id: 'ghost' });
    const row: any = t.db.from('txn').include('staff', 'staff_id', 'seller').first();
    expect(row.seller).toBeNull();
    expect(row.staff).toBeUndefined();
  });

  it('throws for unknown include collections', () => {
    const t = seeded();
    expect(() => t.db.from('products').include('ghosts', 'id')).toThrow(JDBValidationError);
  });
});
