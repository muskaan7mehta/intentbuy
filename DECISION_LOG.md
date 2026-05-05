# IntentBuy — Decision Log

| # | Considered | Chose | Because |
|---|-----------|-------|---------|
| 1 | GPT-4 | gpt-4o-mini | 4 sequential AI calls per request — latency compounds. gpt-4o-mini is fast enough; structured prompts compensate for the reasoning gap |
| 2 | Skincare catalog (original plan) | Shoes + fitness + wellness | Richer reasoning dimensions (gait, use case, fitness goals). Better cross-category gift logic. Skincare tags are too similar to differentiate meaningfully |
| 3 | Re-search threshold of 70 | 60 | 70 triggered re-search too often on legitimate results. 60 catches genuinely poor matches without over-firing |
| 4 | Ask 2-3 clarifying questions | Max 1 question, enforced by session flag | More questions feels like a form. The agent should infer from context. `hasAskedClarify` flag in session makes this a hard guarantee, not a prompt suggestion |
| 5 | Redis for sessions | In-memory Map | Avoids infra complexity for a hackathon demo. Sessions lost on restart — documented as known limitation |
| 6 | Storefront API for product fetching | Admin API for products, Storefront API for cart only | Admin API gives full catalog access regardless of sales channel. Storefront API only returns channel-published products — discovered during build when only 3 of ~40 products appeared |
| 7 | Unlimited re-search retries | Max 2 retries (MAX_ATTEMPTS = 3) | Prevents infinite loops. Forces graceful degradation — after 2 retries the system tells the user honestly rather than endlessly searching |
| 8 | Next.js | Create React App | No SSR needed for a chat interface. Faster setup, simpler local dev, no routing complexity |
| 9 | Voice input | Cut | Adds implementation complexity without improving the core reasoning loop. Depth over breadth. |
| 10 | Hide tradeoffs to seem more confident | Show tradeoffs explicitly in every recommendation | Builds user trust. A recommendation with honest caveats is more credible than one that oversells. Layer 4 prompt explicitly forbids vague tradeoffs like "may not suit everyone" |
| 11 | window.open(url, '_blank') after await | Open blank tab before await, redirect after | Browsers block window.open() calls that happen after async/await (treated as not user-initiated). Opening the blank tab synchronously on click, then setting win.location.href, bypasses this reliably |
| 12 | Show over-budget products with a warning | Hard disqualification in Layer 3 (score = 0, disqualified = true, filtered before Layer 4) | Users lose trust immediately if recommendations ignore their stated budget. Deterministic enforcement is more reliable than a prompt instruction |
| 13 | Per-card "Add to Cart" → immediate Shopify checkout | Per-card adds to local cart state; checkout triggered separately from cart panel | Allows users to compare and collect across multiple recommendation sets before buying. Cart persists in localStorage across page refreshes |
| 14 | Full catalog search by default | Targeted tag search first, full catalog fallback only if tag fetch returns 0 | Reduces noise in the product pool passed to the evaluator. Targeted search → better Layer 3 scores → better picks |
