# jdb 📦

**A local, type-safe JSON database engine for Node.js/Bun.**

`jdb` treats a **folder** as your database and **JSON files** as tables. Designed for high-performance local applications (POS systems, inventory management, desktop apps) with full integration into **ElysiaJS** and **TypeBox**.

> ⚡ **Zero Configuration. Zero Servers. 100% Local.**

---

## 🚀 Features

-   **Folder-Based Storage**: Each collection is a separate `.json` file. Easy to backup, move, or inspect.
-   **Supabase-like API**: Familiar chaining syntax (`select`, `eq`, `insert`, `update`).
-   **Type-Safe by Default**: Built on **TypeBox**. Define your schema once, get validation at runtime and types at compile time.
-   **Relational "Joins"**: Link data across different JSON files using `.include()`.
-   **Atomic Writes**: Prevents data corruption during crashes using temporary files and atomic renames.
-   **Auto-Backup**: Optional automatic backup before every write operation.
-   **In-Memory Indexing**: Lightning-fast lookups even with thousands of records.

---

## 📦 Installation

```bash
npm install jdb
# or
bun add jdb
```

*Peer Dependencies:*
```bash
npm install @sinclair/typebox elysia
```

---

## 🏁 Quick Start

### 1. Initialize Your Database

Point `jdb` to a folder. It will create the folder and necessary files automatically.

```typescript
import { JDB } from 'jdb';
import { t } from '@sinclair/typebox';

// Define your schemas
const ProductSchema = t.Object({
  id: t.String(),
  name: t.String(),
  price: t.Number(),
  stock: t.Integer(),
  category: t.Union([t.Literal('book'), t.Literal('grocery')])
});

const StaffSchema = t.Object({
  id: t.String(),
  name: t.String(),
  role: t.Union([t.Literal('admin'), t.Literal('cashier')]),
  pin: t.String()
});

// Initialize DB
const db = new JDB('./my-store-data', {
  autobackup: true,       // Backup before every write
  backupDir: './backups'  // Where to store backups
});

// Register Collections (Creates .json files if they don't exist)
db.collection('products', ProductSchema);
db.collection('staff', StaffSchema);
```

### 2. Basic CRUD Operations

```typescript
// INSERT
db.from('staff').insert({
  id: db.generateId('S'),
  name: 'Alice',
  role: 'admin',
  pin: '1234'
});

// SELECT
const admin = db.from('staff').eq('role', 'admin').first();

// UPDATE
db.from('products')
  .update({ stock: 50 })
  .eq('id', 'P-101');

// DELETE
db.from('products')
  .eq('id', 'P-999')
  .delete();
```

---

## 🔗 Relational Data (How Files "Talk")

Use `.include()` to join data from different JSON files.

```typescript
const TransactionSchema = t.Object({
  id: t.String(),
  staff_id: t.String(),      // Links to staff.json
  product_id: t.String(),    // Links to products.json
  amount: t.Number(),
  timestamp: t.String()
});

db.collection('transactions', TransactionSchema);

// Query with Joins
const salesReport = db.from('transactions')
  .eq('staff_id', 'S-001')
  .include('staff', 'staff_id')       // 👈 Adds staff details
  .include('products', 'product_id')  // 👈 Adds product details
  .all();

/* Result:
[
  {
    id: "T-1",
    staff_id: "S-001",
    product_id: "P-101",
    amount: 20.00,
    staff: { name: "Alice", role: "admin" }, // From staff.json
    products: { name: "The Great Gatsby", category: "book" } // From products.json
  }
]
*/
```

---

## 🛡️ ElysiaJS Integration

`jdb` works seamlessly with Elysia for end-to-end type safety.

```typescript
import { Elysia } from 'elysia';
import { jdbPlugin } from 'jdb/elysia';

const app = new Elysia()
  .use(jdbPlugin(db)) // Inject db instance
  .post('/sale', ({ body, db }) => {
    // Type-safe insert validated by TypeBox schema
    const sale = db.from('transactions').insert(body);
    return { success: true, id: sale.id };
  }, {
    body: TransactionSchema // Runtime validation
  });
```

---

## 📂 Folder Structure

When you run `new JDB('./data')`, your folder looks like this:

```text
/data/
├── products.json      # Your products collection
├── staff.json         # Your staff collection
├── transactions.json  # Your sales records
└── meta.json          # Internal ID counters & config
```

---

## ⚙️ Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path` | `string` | **Required** | Path to the database folder. |
| `autobackup` | `boolean` | `false` | Create a backup copy before every write. |
| `backupDir` | `string` | `./backups` | Directory to store backup files. |
| `prettyPrint` | `boolean` | `true` | Format JSON files with indentation for readability. |

---

## 🧪 Testing

```bash
npm test
```

---

## 📝 License

MIT

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.
