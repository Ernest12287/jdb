# jdb/elysia 🦊

**The official ElysiaJS plugin for `jdb`.**

This plugin seamlessly integrates your local `jdb` instance into the Elysia request context, providing **end-to-end type safety**, **dependency injection**, and a **Supabase-like developer experience** for your local JSON database.

---

## 🚀 Why use it?

1.  **Zero Boilerplate**: No need to manually import or pass your `db` instance around. It’s just there in your route handlers.
2.  **Type Inference**: Because `jdb` uses TypeBox schemas, the plugin helps Elysia understand your data structure. You get autocomplete for your collections and fields.
3.  **Testability**: Easily swap your production database with a mock or temporary folder for testing without changing your route logic.
4.  **OpenAPI Ready**: Automatically contributes to Elysia's OpenAPI/Swagger generation when used with `@elysiajs/swagger`.

---

## 📦 Installation

```bash
npm install jdb @sinclair/typebox elysia
```

---

## 🏁 Quick Start

### 1. Initialize `jdb` and Register the Plugin

```typescript
import { Elysia } from 'elysia';
import { JDB } from 'jdb';
import { jdbPlugin } from 'jdb/elysia';
import { t } from '@sinclair/typebox';

// Define Schema
const ProductSchema = t.Object({
  id: t.String(),
  name: t.String(),
  price: t.Number()
});

// Initialize DB
const db = new JDB('./store-data');
db.collection('products', ProductSchema);

// Create App & Use Plugin
const app = new Elysia()
  .use(jdbPlugin(db)) // 👈 Injects 'db' into context
  .get('/products', ({ db }) => {
    // 'db' is now available here!
    return db.from('products').all();
  })
  .listen(3000);
```

### 2. Using it in Routes

You can now access `db` in any route handler via the destructured context.

```typescript
app.post('/products', ({ body, db }) => {
  // Type-safe insert
  const newProduct = db.from('products').insert(body);
  return { success: true, product: newProduct };
}, {
  body: ProductSchema // Runtime validation
});

app.get('/products/:id', ({ params, db }) => {
  // Type-safe lookup
  const product = db.from('products').eq('id', params.id).first();
  if (!product) throw new Error('Not found');
  return product;
});
```

---

## 🧪 Testing with Mocks

The plugin makes it easy to test your API against a temporary database.

```typescript
import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { JDB } from 'jdb';
import { jdbPlugin } from 'jdb/elysia';

describe('Product API', () => {
  it('should return all products', async () => {
    // 1. Create a temporary DB for testing
    const testDb = new JDB('./temp-test-db');
    testDb.collection('products', ProductSchema);
    
    // 2. Seed test data
    testDb.from('products').insert({ id: '1', name: 'Test Book', price: 10 });

    // 3. Create app with test DB
    const app = new Elysia()
      .use(jdbPlugin(testDb))
      .get('/products', ({ db }) => db.from('products').all());

    // 4. Test the endpoint
    const res = await app.handle(new Request('http://localhost/products'));
    const data = await res.json();
    
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('Test Book');
  });
});
```

---

## ⚙️ API Reference

### `jdbPlugin(db: JDB)`

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `db` | `JDB` | An initialized instance of the `JDB` class. |

**Returns:** An Elysia plugin that adds the `db` property to the request context.

### Context Decoration

After using the plugin, the following property is available in all route handlers:

| Property | Type | Description |
| :--- | :--- | :--- |
| `db` | `JDB` | The injected database instance with full type inference. |

---

## 📝 License

MIT