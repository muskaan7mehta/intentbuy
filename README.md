# IntentBuy — AI Shopping Agent

> Replace the browse-search-filter loop with a single conversation.

IntentBuy is a conversational AI shopping agent built on Shopify. Describe what you need (or who you're buying for), and the agent understands the person behind the request — not just keywords — returning the 3 best matches with reasoning, tradeoffs, and a direct checkout link.

**Kasparro Agentic Commerce Hackathon — Track 1: AI Shopping Agent**

---

## Demo Video
[Link to be added]

## Screenshots
![IntentBuy UI](screenshots/main.png)

---

## How It Works

4-layer agentic pipeline, all running server-side:

1. **Intent parsing** — LLM extracts structured params from plain language: budget (hard number), gait type for running, full recipient profile for gifts, search strategy
2. **Shopify fetch** — Admin API pulls live catalog filtered by tags and budget. Falls back to full catalog if tag search returns nothing
3. **Quality evaluation** — LLM scores products 0-100. Products over budget are hard-disqualified. If all top-3 scores < 60, re-searches with different tags (max 2 retries)
4. **Final recommendation** — top 3 picks with specific reasoning (product feature vs user need) and honest tradeoffs

The agent asks at most **one** clarifying question per conversation — only when the missing info would fundamentally change the results. A session flag ensures it never asks twice.

---

## Setup

### Prerequisites
- Node.js v18+
- Shopify Partner account with a dev store
- OpenAI API key

### 1. Clone the repo
```bash
git clone https://github.com/muskaan7mehta/intentbuy.git
cd intentbuy
```

### 2. Create `.env` in the root directory
```
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxx
SHOPIFY_STOREFRONT_TOKEN=xxx
OPENAI_API_KEY=sk-xxx
```

### 3. Run the backend
```bash
cd backend
npm install
node index.js
# Runs on http://localhost:3001
```

### 4. Run the frontend
```bash
cd frontend
npm install
npm start
# Runs on http://localhost:3000
```

### 5. Seed products (first time only)
```bash
cd scripts
NODE_TLS_REJECT_UNAUTHORIZED=0 node seed.js
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React (Create React App) |
| Backend | Node.js + Express |
| AI | OpenAI gpt-4o-mini |
| Product catalog | Shopify Admin API |
| Cart + checkout | Shopify Storefront API (+ URL fallback) |
| Session state | In-memory Map (localStorage for session ID and cart) |

---

## Project Structure

```
intentbuy/
├── backend/
│   └── index.js          # Express server, all 4 layers, /chat and /cart routes
├── frontend/
│   └── src/
│       ├── App.js         # React app — chat UI, cart panel, all components
│       └── App.css        # All styles, animations, responsive
├── scripts/
│   └── seed.js            # Seeds Shopify dev store with products
├── .env                   # Not committed — see setup above
├── PRODUCT_DOCUMENT.md
├── TECHNICAL_DOCUMENT.md
└── DECISION_LOG.md
```

---

## Key Design Choices

- **Hard budget enforcement** — over-budget products are disqualified in Layer 3 and never reach the ranker. Deterministic, not prompt-based.
- **Re-search capped at 2 retries** — if two attempts still return poor matches, the agent says so honestly rather than returning bad results.
- **One clarifying question max** — enforced by a session-level flag, not a prompt instruction. Can't be hallucinated away.
- **Popup blocker fix** — `window.open('', '_blank')` fires synchronously on click; the URL is set after the async cart call resolves. Avoids the popup blocker that fires on `window.open` after `await`.

---

## Known Limitations

- Sessions are in-memory — lost on server restart (fix: Redis)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set for local dev SSL — remove in production
- No product images in dev store
- Cart persists in localStorage — cleared if user clears browser data

---

## Author

Solo project — Muskaan Mehta  
Time split: ~40% product thinking and scoping, ~60% engineering and iteration.
