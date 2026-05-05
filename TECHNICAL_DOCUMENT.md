# IntentBuy — Technical Document

## System Architecture

```
User message (React frontend, port 3000)
        ↓ POST /chat { message, sessionId }
Express backend (Node.js, port 3001)
        ↓
[Layer 1] analyzeIntent() — gpt-4o-mini
Extracts: { tags[], budget, primaryCategory, secondaryCategories[],
            gait, isGift, mode, recipientProfileUpdate,
            searchStrategy: "targeted" | "broad",
            clarifyQuestion, clarifyOptions }
        ↓ (if clarifyQuestion and !hasAskedClarify → return question to user)
[Layer 2] Shopify Admin API fetch
GET /admin/api/2024-01/products.json?limit=250&status=active
Tag-filtered fetch, deduplicated. Falls back to full catalog if tag fetch returns 0 results.
Budget filter applied (hard cutoff — keeps only products ≤ budget).
        ↓
[Layer 3] evaluateProducts() — gpt-4o-mini
Scores each product 0-100. Weights:
  - Category relevance: 30%
  - Use case match:     40%
  - Recipient/person fit: 30% (50% in gift mode)
Products over budget → disqualified: true (stripped before Layer 4)
If all qualified top-3 scores < 60 → isRefining = true, retry with alternativeTags (max 2 retries)
        ↓
[Layer 4] rankProducts() — gpt-4o-mini
Top 3 picks from qualified, score-sorted pool.
Each pick: specific reason (product feature vs user need), honest tradeoff, matchScore.
        ↓
Response: { type: "results", picks[], summary, followUpQuestion, isRefining }
        ↓
POST /cart { variantIds[] }
  → Attempt: Shopify Storefront API cartCreate mutation
  → Fallback: https://store.myshopify.com/cart/ID1:1,ID2:1
Returns: { checkoutUrl }
        ↓
Frontend: window opened before await, redirected to checkoutUrl on resolution
```

## AI vs Deterministic Boundary

**AI handles:**
- Intent understanding and parameter extraction (Layer 1)
- Product scoring against user needs (Layer 3)
- Recommendation reasoning and tradeoff generation (Layer 4)
- Gift recipient profile inference across conversation turns
- Clarifying question generation (max 1 per session)

**Deterministic code handles:**
- Budget filtering (hard cutoff — products over budget never reach Layer 4)
- Re-search trigger (score < 60 threshold)
- Session state management (`sessions` Map, in-memory)
- All Shopify API calls (Admin API for products, Storefront API for cart)
- Cart URL construction and fallback
- `hasAskedClarify` session guard (prevents asking twice)
- `callAIJSON` retry on JSON parse failure

**Why this boundary:** AI is used where judgment and language understanding are required. Deterministic code handles anything that must be reliable, testable, and not subject to hallucination — especially the budget cutoff, which is a trust-critical feature.

## Session Memory

```javascript
sessions Map: sessionId → {
  history: [{ role, content }],   // last 20 messages, used in Layer 1 context
  personProfile: {                 // buyer's own profile (goal, gait, etc.)
    isGift: bool,
    ...extracted fields
  },
  recipientProfile: {              // built across turns in gift mode
    occasion: null,
    relationship: null,            // "dad" | "mom" | "friend" | "colleague"
    age: null,
    gender: null,
    lifestyle: null,               // "active" | "sedentary" | "busy"
    interests: [],
    budget: null,
    constraints: []                // e.g. ["hates gym equipment"]
  },
  hasAskedClarify: false           // hard flag — prevents repeat questions
}
```

`recipientProfile` is merged with array-safe deduplication on every turn (interests and constraints use `new Set`). In gift mode, Layer 3 uses `recipientProfile` instead of `personProfile` for scoring.

## JSON Reliability — callAIJSON()

All AI calls that require structured output go through `callAIJSON()`:
1. Calls the model and attempts `JSON.parse` on the response
2. If parse fails: retries once with a stricter system prompt: `"Respond with ONLY a valid JSON object. No markdown, no explanation, no code fences."`
3. If second parse also fails: returns the `fallback` object passed by the caller
4. Each caller defines its own fallback, so partial failures degrade gracefully rather than crash

## Failure Handling

| Failure | Handling |
|---------|----------|
| OpenAI malformed JSON | `callAIJSON` retries once with stricter prompt; returns fallback object if still fails |
| Shopify API down | Caught in Layer 2 try/catch; returns `type: "no_results"` with catalog-unavailable message |
| Tag fetch returns 0 results | Falls back to `fetchAllProducts()` (full catalog); `usedFallback` flag passed to Layer 4 prompt |
| All re-search attempts exhausted with scores < 60 | Returns honest `type: "no_results"` message instead of poor results |
| Storefront API cart creation fails | Falls back to `/cart/ID1:1,ID2:1` URL (works unconditionally on all Shopify stores) |
| Budget too low (< ₹200) | Immediate response before Shopify fetch with actual minimum price |
| Nonsensical input (`isNonsense: true`) | Guided response asking user to describe their need differently |
| `window.open()` blocked by popup blocker | Window opened synchronously before `await`; URL assigned to already-open blank tab after |

## API Endpoints

### POST /chat
```
Body:    { message: string, sessionId: string }
Returns: { type: "results" | "question" | "no_results",
           picks?: [...], summary?: string, followUpQuestion?: string,
           isRefining?: bool }
         | { type: "question", question: string, options: string[] }
         | { type: "no_results", message: string }
```

### POST /cart
```
Body:    { variantIds: (number | string)[] }
         — accepts numeric IDs or gid://shopify/ProductVariant/ID format
Returns: { checkoutUrl: string, cartId?: string, fallback?: bool }
```

### GET /health
```
Returns: { status: "ok", shop: string }
```

## Known Limitations

- Sessions stored in memory — lost on server restart. Fix: Redis with TTL.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` used for local dev SSL workaround — must be removed in production.
- No product images (dev store upload overhead not worth it for demo).
- OpenAI rate limits handled with single retry only — no exponential backoff.
- Cart state in `localStorage` (`intentbuy_cart`) — cleared if user clears browser storage.
- `limit: 250` on product fetch — sufficient for demo catalog, would need pagination for large stores.

## What I'd Improve With More Time

- **Redis sessions** with 24h TTL — persistent across restarts, horizontally scalable
- **Streaming responses** via Server-Sent Events for faster perceived latency
- **Semantic search** using embeddings once catalog grows beyond ~100 products
- **Exponential backoff** on OpenAI rate limit errors
- **Product images** fetched from Shopify and shown in cards
- **Order tracking** — post-purchase support as a natural conversation extension
