# IntentBuy — Product Document

## The Problem

Online shopping forces users to do all the cognitive work. Search bars return 200 results for "shoes" and expect the user to filter, compare, and decide alone. For goal-oriented shopping ("I need something for my health") or gift buying ("something for my tired dad"), keyword search completely breaks down.

## Who This Is For

Individual buyers on Shopify stores who know what they want to achieve but not what to buy. Especially: gift buyers, health-goal shoppers, and anyone who finds browsing exhausting.

## What We Built

IntentBuy is a conversational AI shopping agent. The user describes their need in plain language. The agent understands the person behind the request — not just the keywords — fetches real products from a Shopify store, evaluates them against actual needs, and creates a cart with a direct checkout link.

## Core User Journey

1. User types a natural language need
2. Agent asks ONE clarifying question if critical info is missing (gait type for running, age/gender for gifts, budget if category is unclear)
3. Agent searches Shopify catalog via Admin API, filtered by tags and budget
4. Agent scores every product 0-100 against the user's actual need
5. If top 3 score below 60 → re-searches with different parameters (max 2 retries)
6. Returns top 3 picks with match score, specific reasoning, and honest tradeoffs
7. User adds to in-app cart → clicks "Checkout on Shopify →" → completes purchase

## Key Product Decisions

**Catalog: shoes + fitness + wellness**
Chosen because it gives the agent meaningful cross-category reasoning space. A gift query for a "tired dad who wants better health" should return foam rollers and resistance bands — not just shoes. Enough variety to demonstrate depth, focused enough to do it well.

**One clarifying question maximum**
More than one feels like a survey and defeats the purpose of conversational shopping. The agent asks only when the missing information would fundamentally change the results (gait type for running, age/gender for gifts, budget when category is completely unclear). A session-level `hasAskedClarify` flag prevents the agent from ever asking twice. If enough context exists, it searches immediately.

**Re-search loop capped at 2 retries**
Prevents infinite loops. Forces graceful degradation — if two attempts don't find good matches, the system tells the user honestly rather than returning poor results. Threshold is score < 60; below that, we consider the results genuinely unhelpful.

**Show tradeoffs explicitly**
Every recommendation includes what it doesn't do well. This builds trust and differentiates from keyword search, which shows you everything and explains nothing. The Layer 4 prompt explicitly instructs: name a real limitation, not a vague caveat.

**In-app cart before Shopify checkout**
Users can compare and select across multiple recommendations before going to checkout. The cart persists via `intentbuy_cart` in localStorage, surviving page refresh. One "Checkout on Shopify →" button sends everything to a real Shopify cart via the Storefront API, with a `/cart/ID:1,ID:1` URL fallback.

**Hard budget enforcement in Layer 3**
Products over budget are marked `disqualified: true` by the evaluator and filtered out before Layer 4 ever sees them. The budget cutoff is deterministic — not a prompt instruction — so it cannot be ignored or reasoned around by the model.

## What We Chose NOT to Build

**Voice input** — adds implementation complexity without improving the core reasoning loop.

**Cross-merchant search** — out of scope for a single-store demo. The agent logic would transfer, but the catalog architecture would need rethinking.

**User accounts and history** — not needed to demonstrate the agent's value. Sessions are in-memory (`sessions` Map, keyed by sessionId from localStorage) and sufficient for the demo.

**Product images** — Shopify dev store image upload is cumbersome and not core to the recommendation reasoning.

**Price negotiation or discount logic** — outside the core "find the right product" loop.

## Tradeoffs Encountered

**GPT-4 vs gpt-4o-mini:** Chose gpt-4o-mini. Four sequential AI calls per request means latency compounds. gpt-4o-mini is fast enough and the structured prompts compensate for the reasoning gap.

**In-memory sessions vs database:** Chose in-memory. Sessions are lost on server restart. Acceptable for a hackathon demo — a Redis layer would fix this in production.

**Admin API vs Storefront API for products:** Admin API gives full catalog access. Storefront API only returns products published to specific sales channels — discovered during build when only 3 products appeared. Used Admin API for fetching, Storefront API only for cart creation.
