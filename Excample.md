Here is the updated, complete end-to-end example. It now includes the **`jdb.view()`** visualizer and demonstrates how to run the POS API and the Admin Dashboard simultaneously.

### 📂 Project Structure
```text
/my-retail-app/
├── index.ts          # The main logic
├── store-data/       # Your JSON database folder (auto-created)
│   ├── products.json
│   ├── staff.json
│   ├── transactions.json
│   └── meta.json
└── backups/          # Auto-generated backups
```

### 💻 Complete Code Example (`index.ts`)

```typescript
import { JDB } from 'jdb';
import { t } from '@sinclair/typebox';
import { Elysia } from 'elysia';
import { jdbPlugin } from 'jdb/elysia';

// --- 1. DEFINE SCHEMAS (The "Contract") ---
const ProductSchema = t.Object({
  id: t.String(),
  name: t.String(),
  type: t.Union([t.Literal('book'), t.Literal('grocery')]),
  price: t.Number({ minimum: 0 }),
  stock: t.Integer({ minimum: 0 }),
  barcode: t.String()
});

const StaffSchema = t.Object({
  id: t.String(),
  name: t.String(),
  role: t.Union([t.Literal('admin'), t.Literal('cashier')]),
  pin: t.String()
});

const TransactionSchema = t.Object({
  id: t.String(),
  timestamp: t.String(),
  staff_id: t.String(),
  product_id: t.String(),
  quantity: t.Integer(),
  total: t.Number()
});

// --- 2. INITIALIZE DATABASE ---
const db = new JDB('./store-data', {
  autobackup: true,
  backupDir: './backups',
  prettyPrint: true
});

// Register collections (Creates .json files if missing)
db.collection('products', ProductSchema);
db.collection('staff', StaffSchema);
db.collection('transactions', TransactionSchema);

console.log("✅ Database Initialized at ./store-data");

// --- 3. SEED DATA (INSERT API) ---
console.log("\n--- Seeding Data ---");

// Add Staff
const admin = db.from('staff').insert({
  id: db.generateId('S'),
  name: 'Sarah Admin',
  role: 'admin',
  pin: '9999'
});

const cashier = db.from('staff').insert({
  id: db.generateId('S'),
  name: 'Bob Cashier',
  role: 'cashier',
  pin: '1234'
});

// Add Products
const book = db.from('products').insert({
  id: db.generateId('P'),
  name: 'The Great Gatsby',
  type: 'book',
  price: 12.50,
  stock: 50,
  barcode: '978-3-16-123'
});

const milk = db.from('products').insert({
  id: db.generateId('P'),
  name: 'Whole Milk 1L',
  type: 'grocery',
  price: 3.99,
  stock: 100,
  barcode: '5000-1234'
});

// --- 4. QUERYING & FILTERING (SELECT, EQ, GT, LIKE) ---
console.log("\n--- Querying Data ---");

// Find all books with stock > 10
const availableBooks = db.from('products')
  .eq('type', 'book')
  .gt('stock', 10)
  .all();
console.log(`📚 Available Books: ${availableBooks.length}`);

// Find a specific product by barcode
const foundMilk = db.from('products')
  .eq('barcode', '5000-1234')
  .first();
console.log(`🥛 Found: ${foundMilk?.name} ($${foundMilk?.price})`);

// Search by name (Like)
const searchResults = db.from('products')
  .like('name', 'gatsby')
  .select(['name', 'price']) // Only return specific fields
  .all();
console.log(`🔍 Search Results:`, searchResults);

// --- 5. RELATIONAL JOINS (INCLUDE API) ---
console.log("\n--- Relational Joins ---");

// Simulate a sale
const sale = db.from('transactions').insert({
  id: db.generateId('TXN'),
  timestamp: new Date().toISOString(),
  staff_id: cashier.id,
  product_id: book.id,
  quantity: 2,
  total: 25.00
});

// Get the sale record WITH staff and product details
const enrichedSale = db.from('transactions')
  .eq('id', sale.id)
  .include('staff', 'staff_id')      // 👈 Joins staff.json
  .include('products', 'product_id') // 👈 Joins products.json
  .first();

console.log("🧾 Enriched Receipt:", JSON.stringify(enrichedSale, null, 2));

// --- 6. UPDATES & DELETES ---
console.log("\n--- Updates & Deletes ---");

// Deduct stock after sale
db.from('products')
  .update({ stock: book.stock - 2 })
  .eq('id', book.id);

const updatedBook = db.from('products').eq('id', book.id).first();
console.log(`📉 Updated Stock for '${updatedBook?.name}': ${updatedBook?.stock}`);

// Delete a test record
db.from('transactions')
  .eq('id', 'TXN-TEST-DELETE')
  .delete();

// --- 7. PAGINATION (LIMIT & OFFSET) ---
console.log("\n--- Pagination ---");
const page1 = db.from('products')
  .limit(2)
  .offset(0)
  .all();
console.log(`📄 Page 1 Items: ${page1.map(p => p.name).join(', ')}`);

// --- 8. START VISUALIZER (jdb.view) ---
console.log("\n--- Starting Data Visualizer ---");
// Opens a dashboard at http://localhost:3001 to view live data
db.view({ 
  port: 3001, 
  autoOpen: false,
  readOnly: true 
});

// --- 9. ELYSIAJS INTEGRATION (POS API) ---
console.log("\n--- Starting POS API Server ---");

const app = new Elysia()
  .use(jdbPlugin(db)) // Injects typed 'db' into context
  
  // Get all products for the POS interface
  .get('/products', ({ db }) => {
    return db.from('products').all();
  })
  
  // Process a login
  .post('/login', ({ body }) => {
    const user = db.from('staff').eq('pin', body.pin).first();
    if (!user) throw new Error('Invalid PIN');
    return { welcome: user.name, role: user.role };
  }, {
    body: t.Object({ pin: t.String() })
  })
  
  // Process a sale
  .post('/sale', ({ body, db }) => {
    const sale = db.from('transactions').insert(body);
    return { success: true, txnId: sale.id };
  }, {
    body: TransactionSchema
  })
  
  .listen(3000);

console.log(`🦊 POS API running at http://localhost:${app.server?.port}`);
console.log(`📊 Admin Dashboard running at http://localhost:3001`);
```

### 🔍 What Happens in `./store-data/`?

After running this script, your folder will contain clean, organized JSON files:

**`products.json`**
```json
[
  {
    "id": "P-0001",
    "name": "The Great Gatsby",
    "type": "book",
    "price": 12.5,
    "stock": 48, 
    "barcode": "978-3-16-123"
  },
  {
    "id": "P-0002",
    "name": "Whole Milk 1L",
    "type": "grocery",
    "price": 3.99,
    "stock": 100,
    "barcode": "5000-1234"
  }
]
```

**`transactions.json`**
```json
[
  {
    "id": "TXN-0001",
    "timestamp": "2026-10-05T14:30:00.000Z",
    "staff_id": "S-0002",
    "product_id": "P-0001",
    "quantity": 2,
    "total": 25
  }
]
```

### 🌟 Key Takeaways from the Example

1.  **Dual-Server Setup**: You can run your **POS API** (Port 3000) and your **Admin Dashboard** (Port 3001) side-by-side using the same `jdb` instance.
2.  **Type Safety**: If you try to insert a product with `stock: "ten"`, TypeBox will throw an error before it even hits the file system.
3.  **Atomic Updates**: The stock deduction and transaction creation are handled safely.
4.  **Relational Power**: The `.include()` method turns simple IDs into full objects, making it easy to generate receipts or reports.
5.  **Live Visualization**: By visiting `http://localhost:3001`, you can see the sales happening in real-time as you hit the API endpoints.