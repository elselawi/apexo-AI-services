# expense-reader

Cloudflare Worker that scans receipt images using Google Gemini 2.5 Flash and returns structured JSON.

## Setup

1. **Get a Gemini API key** — https://aistudio.google.com/apikey

2. **Add it as a secret:**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   ```

3. **Set your KV namespace ID** in `wrangler.jsonc` (line with `"id": "..."`)

4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```

## Auth

Send two headers on every request:

| Header | Description |
|--------|-------------|
| `x-server` | Server identifier (must exist as a KV key) |
| `x-worker-key` | Secret key (SHA-256 hashed, compared against KV) |

## API

### `POST /`

Send the receipt image as `multipart/form-data`.

**Form fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | File | Yes | Receipt image (also accepts `file` or `receipt` field names) |
| `suppliers` | String | Yes | Comma-separated supplier names, e.g. `"Walmart,Costco,Target"` |

### Success response (200)

```json
{
  "supplierName": "Echo Dental Supplies",
  "orderDate": "2024-05-02",
  "orderItems": [
    {
      "name": "GC Posterior",
      "quantity": 5,
      "unitPrice": 197600,
      "totalPrice": 988000
    }
  ],
  "totalPrice": 988000
}
```

### Error responses

| Status | Meaning |
|--------|---------|
| 401 | Missing or invalid `x-server` / `x-worker-key` |
| 400 | Missing `suppliers` or `image` |
| 500 | Gemini API error (retried 3× with backoff) |

## Flutter example

See [`example.dart`](example.dart) — uses `image_picker` and `http` packages:

```dart
final service = ExpenseReaderService(
  workerUrl: 'https://expense-reader.your-subdomain.workers.dev',
  server: 'my-server',
  key: 'my-secret-key',
  suppliers: ['Walmart', 'Costco', 'Target'],
);

final receipt = await service.readReceiptFromPicker();
print(receipt.supplierName); // "Walmart"
```

## Development

```bash
npm run dev       # Start local dev server
npm run deploy    # Deploy to Cloudflare
npm test          # Run tests
```
