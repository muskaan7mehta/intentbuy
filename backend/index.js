// Must be first — fixes SSL cert errors on macOS dev stores
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const SHOP = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

['SHOPIFY_STORE_URL', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_STOREFRONT_TOKEN', 'OPENAI_API_KEY'].forEach(key => {
  if (!process.env[key]) console.error(`⚠️  Missing env var: ${key}`);
  else console.log(`✓ ${key} loaded (${process.env[key].slice(0, 8)}...)`);
});

// ── Session memory ───────────────────────────────────────────────
// sessions[sessionId] = { history, personProfile, recipientProfile, searchAttempts }
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [],
      personProfile: {},
      recipientProfile: {
        occasion: null,
        relationship: null,
        age: null,
        gender: null,
        lifestyle: null,
        interests: [],
        budget: null,
        constraints: []
      },
      searchAttempts: 0
    });
  }
  return sessions.get(sessionId);
}

// ── Shopify product fetchers ─────────────────────────────────────
async function fetchProductsByTag(tag) {
  try {
    const res = await axios.get(
      `https://${SHOP}/admin/api/2024-01/products.json`,
      {
        params: { limit: 250, status: 'active' },
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      }
    );
    return res.data.products.filter(p =>
      p.tags.toLowerCase().split(',').map(t => t.trim()).some(t => t === tag.toLowerCase())
    );
  } catch (err) {
    console.error(`Shopify tag fetch error (tag: ${tag}):`, err.message);
    return [];
  }
}

async function fetchAllProducts() {
  try {
    const res = await axios.get(
      `https://${SHOP}/admin/api/2024-01/products.json`,
      {
        params: { limit: 250, status: 'active' },
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      }
    );
    return res.data.products;
  } catch (err) {
    console.error('Shopify fetch all error:', err.message);
    return [];
  }
}

// ── OpenAI caller ────────────────────────────────────────────────
async function callAI(systemPrompt, userMessage, history = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o-mini', max_tokens: 1200, messages },
      { headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' } }
    );
    return res.data.choices[0].message.content;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('OpenAI error:', detail);
    throw new Error(`OpenAI call failed: ${detail}`);
  }
}

function safeParseJSON(raw, fallback) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    console.error('JSON parse failed on:', raw.slice(0, 200));
    return fallback;
  }
}

// ── Layer 1: Intent to Search Query ─────────────────────────────
// Converts raw user input into structured search parameters.
// Also decides if a single clarifying question is needed.
// Also updates gift recipient profile from conversation.
async function analyzeIntent(message, session) {
  const { personProfile, recipientProfile, history } = session;

  const system = `You are an AI shopping agent. Analyze the user's message and convert it into structured search parameters.

Current person profile: ${JSON.stringify(personProfile)}
Current recipient profile: ${JSON.stringify(recipientProfile)}

Available product tags in store: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

CLARIFYING QUESTION RULES — pick AT MOST ONE, then stop:
1. Budget missing AND product category completely unclear → ask about budget range
2. It is clearly a GIFT and recipient age/gender are unknown → ask age + gender in one question
3. User mentioned running shoes AND foot type is unknown → ask foot type (flat/neutral/high arch)
4. Enough info exists to search meaningfully → set clarifyQuestion to null, search immediately
5. NEVER ask more than one question. If already asked once this session, do NOT ask again.

GIFT PROFILE: When isGift=true, extract all available info about the recipient from the message and set recipientProfileUpdate:
{ occasion, relationship, age, gender, lifestyle (active/sedentary/busy), interests (array of strings), budget, constraints (array of strings) }
Set fields to null if not mentioned. Only include fields that have new information.

SEARCH PARAMS: Produce the best possible search parameters from what you know:
- tags: subset of available tags above
- budget: numeric INR value or null
- useCase: brief description of what they need
- searchAll: true for broad/open-ended or gift-with-no-category requests
- category: primary category name

MODE: SINGLE (one product for themselves), BUNDLE (kit/set), GIFT (buying for someone else)

Respond ONLY with valid JSON:
{
  "searchParams": {
    "tags": ["fitness", "wellness"],
    "budget": 5000,
    "useCase": "home workout for beginners",
    "category": "fitness",
    "searchAll": false
  },
  "isGift": false,
  "mode": "SINGLE",
  "recipientProfileUpdate": null,
  "personProfileUpdate": { "goal": "fitness" },
  "clarifyQuestion": null,
  "clarifyOptions": null
}`;

  const raw = await callAI(system, message, history.slice(-6));
  return safeParseJSON(raw, {
    searchParams: { tags: [], budget: null, useCase: '', category: '', searchAll: true },
    isGift: false,
    mode: 'SINGLE',
    recipientProfileUpdate: null,
    personProfileUpdate: {},
    clarifyQuestion: null,
    clarifyOptions: null
  });
}

// ── Layer 3: Quality Evaluation ──────────────────────────────────
// Scores each product 0-100. Signals if re-search is needed.
async function evaluateProducts(products, searchParams, session) {
  if (products.length === 0) {
    return { scores: [], needsResearch: false, alternativeTags: [] };
  }

  const { personProfile, recipientProfile } = session;
  const profile = personProfile.isGift ? recipientProfile : personProfile;

  const productList = products.slice(0, 30).map((p, i) => {
    const tags = p.tags.split(',').map(t => t.trim()).join(', ');
    const price = p.variants[0]?.price || '?';
    const desc = p.body_html?.replace(/<[^>]*>/g, '').slice(0, 100) || '';
    return `${i + 1}. ${p.title} | ₹${price} | Tags: ${tags} | ${desc}`;
  }).join('\n');

  const system = `You are a product quality evaluator for an AI shopping agent.

User profile: ${JSON.stringify(profile)}
Search use case: "${searchParams.useCase || 'general shopping'}"
Budget: ${searchParams.budget ? `₹${searchParams.budget}` : 'not specified'}

Score each product 0-100 on how well it matches the user's actual needs:
- 90-100: Perfect match for their situation
- 70-89: Good match, meets core needs
- 50-69: Partial match, somewhat relevant
- 30-49: Weak match, tangentially related
- 0-29: Poor match

If ALL top 3 scores are below 60, set needsResearch=true and list better alternativeTags to try next.
Available tags to suggest: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

Respond ONLY with valid JSON:
{
  "scores": [
    { "productIndex": 1, "score": 85, "brief": "Good for home workouts" }
  ],
  "needsResearch": false,
  "alternativeTags": []
}`;

  const raw = await callAI(system, productList);
  return safeParseJSON(raw, {
    scores: products.slice(0, 10).map((_, i) => ({ productIndex: i + 1, score: 55, brief: '' })),
    needsResearch: false,
    alternativeTags: []
  });
}

// ── Layer 4: Final Recommendation ───────────────────────────────
// Picks top 3 and generates reasoning + tradeoffs.
async function rankProducts(products, personProfile, userMessage, usedFallback = false) {
  if (products.length === 0) return { picks: [], summary: "No products found.", followUpQuestion: null };

  const capped = products.slice(0, 40);

  const KNOWN_CATS = ['running','casual','formal','training','trail','fitness','wellness','yoga','gym','recovery'];
  const productList = capped.map((p, i) => {
    const tags = p.tags.split(',').map(t => t.trim());
    const primaryCat = KNOWN_CATS.find(c => tags.includes(c)) || tags[0] || 'other';
    return `${i + 1}. [CAT:${primaryCat}] ${p.title} — ₹${p.variants[0]?.price || '?'} — ${p.body_html?.replace(/<[^>]*>/g, '').slice(0, 100)}`;
  }).join('\n');

  const availableCats = [...new Set(capped.map(p => {
    const tags = p.tags.split(',').map(t => t.trim());
    return KNOWN_CATS.find(c => tags.includes(c)) || 'other';
  }))];
  const SHOE_CATS = new Set(['running','casual','formal','training','trail','gym']);
  const nonShoeCats = availableCats.filter(c => !SHOE_CATS.has(c));
  const isGiftOrOpen = personProfile.isGift || (!personProfile.goal && availableCats.length >= 3);

  let diversityRule;
  if (availableCats.length >= 3) {
    const shoeConstraint = (isGiftOrOpen && nonShoeCats.length >= 2)
      ? `SHOE CONSTRAINT: At most 1 pick can be a shoe (CAT: running/casual/formal/training/trail/gym). Prioritise non-shoe categories like fitness, recovery, wellness.`
      : '';
    diversityRule = `DIVERSITY RULE: You MUST pick from 3 different [CAT:...] categories — no two picks from the same category. ${shoeConstraint}`;
  } else {
    diversityRule = `Pick the 3 most relevant products for this person.`;
  }

  const fallbackNote = usedFallback
    ? `Note: The exact category requested isn't in our catalog. Pick the closest alternatives and acknowledge this naturally in your summary.`
    : '';

  const system = `You are an expert shopping advisor for IntentBuy.

User's person profile: ${JSON.stringify(personProfile)}
Original request: "${userMessage}"
${diversityRule}
${fallbackNote}

From the product list below, pick the TOP 3 best matches for this PERSON.
Each pick must serve a different purpose or angle — not just be from a different brand.

Return ONLY valid JSON (no markdown):
{
  "picks": [
    {
      "rank": 1,
      "productIndex": 3,
      "matchScore": 91,
      "reason": "Perfect because... (1-2 sentences, specific to their situation)",
      "tradeoff": "Worth noting..."
    }
  ],
  "summary": "Here's what I found — [2 sentences mentioning the variety and why each serves a different need]",
  "followUpQuestion": null
}
productIndex is 1-based from the list.
followUpQuestion: only if a specific question would meaningfully improve picks, else null.`;

  const raw = await callAI(system, productList);
  return safeParseJSON(raw, { picks: [], summary: "Here are some options for you.", followUpQuestion: null });
}

// ── Main Chat Route ──────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const session = getSession(sessionId);
  console.log(`\n[${sessionId}] User: "${message}"`);

  try {
    // ── Layer 1: Intent to Search Query ─────────────────────────
    console.log('[Layer 1] Analyzing intent and building search params...');
    const analysis = await analyzeIntent(message, session);
    console.log('[Layer 1] Search params:', JSON.stringify(analysis.searchParams));
    console.log('[Layer 1] Gift:', analysis.isGift, '| Mode:', analysis.mode, '| Clarify:', !!analysis.clarifyQuestion);

    // Update person profile from Layer 1
    if (analysis.personProfileUpdate && Object.keys(analysis.personProfileUpdate).length) {
      session.personProfile = { ...session.personProfile, ...analysis.personProfileUpdate };
    }
    if (analysis.isGift) session.personProfile.isGift = true;

    // Update recipient profile (Feature 3: Deep Gift Profile Building)
    if (analysis.isGift && analysis.recipientProfileUpdate) {
      const update = analysis.recipientProfileUpdate;
      // Merge arrays, replace scalars
      session.recipientProfile = {
        ...session.recipientProfile,
        ...update,
        interests: [
          ...new Set([...(session.recipientProfile.interests || []), ...(update.interests || [])])
        ],
        constraints: [
          ...new Set([...(session.recipientProfile.constraints || []), ...(update.constraints || [])])
        ]
      };
      console.log('[Layer 1] Recipient profile:', JSON.stringify(session.recipientProfile));
    }

    // Feature 2: Smart single clarifying question (pre-search check)
    if (analysis.clarifyQuestion) {
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: analysis.clarifyQuestion });
      return res.json({
        type: 'question',
        question: analysis.clarifyQuestion,
        options: analysis.clarifyOptions || null
      });
    }

    // ── Layer 2 + 3: Fetch & Evaluate with re-search loop ────────
    let products = [];
    let usedFallback = false;
    let evaluation = null;
    let currentSearchParams = { ...analysis.searchParams };
    let isRefining = false;
    const MAX_ATTEMPTS = 3; // initial fetch + up to 2 re-searches

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ── Layer 2: Shopify Fetch ───────────────────────────────
      console.log(`[Layer 2] Attempt ${attempt}: tags=[${currentSearchParams.tags}] searchAll=${currentSearchParams.searchAll}`);

      let fetched = [];
      if (currentSearchParams.searchAll || !currentSearchParams.tags?.length) {
        fetched = await fetchAllProducts();
      } else {
        const tagFetches = await Promise.all(currentSearchParams.tags.map(tag => fetchProductsByTag(tag)));
        const seen = new Set();
        for (const batch of tagFetches) {
          for (const p of batch) {
            if (!seen.has(p.id)) { seen.add(p.id); fetched.push(p); }
          }
        }
        if (fetched.length === 0) {
          console.log(`[Layer 2] No tag results — falling back to full catalog`);
          fetched = await fetchAllProducts();
          usedFallback = true;
        }
      }

      // Budget filter — use recipient budget for gifts, else user budget
      const budget = analysis.isGift
        ? (session.recipientProfile.budget || currentSearchParams.budget)
        : currentSearchParams.budget;

      if (budget) {
        const withinBudget = fetched.filter(p => parseFloat(p.variants[0]?.price) <= budget);
        console.log(`[Layer 2] Budget filter ≤₹${budget}: ${fetched.length} → ${withinBudget.length}`);
        if (withinBudget.length > 0) {
          fetched = withinBudget;
        } else if (attempt === MAX_ATTEMPTS) {
          const minPrice = Math.min(...fetched.map(p => parseFloat(p.variants[0]?.price) || 99999));
          const noResultMsg = `I don't have anything under ₹${budget.toLocaleString('en-IN')} right now. The most affordable options start at ₹${minPrice.toLocaleString('en-IN')}. Want me to show you the best picks around that price?`;
          session.history.push({ role: 'user', content: message });
          session.history.push({ role: 'assistant', content: noResultMsg });
          return res.json({ type: 'no_results', message: noResultMsg });
        }
        // else: keep going with full set, next re-search may find something
      }

      products = fetched;
      console.log(`[Layer 2] Products available: ${products.length}`);

      // ── Layer 3: Quality Evaluation ─────────────────────────
      console.log(`[Layer 3] Evaluating ${Math.min(products.length, 30)} products...`);
      evaluation = await evaluateProducts(products, currentSearchParams, session);

      const sortedScores = [...(evaluation.scores || [])].sort((a, b) => b.score - a.score);
      const top3Scores = sortedScores.slice(0, 3).map(s => s.score);
      console.log('[Layer 3] Scores:', JSON.stringify(sortedScores.slice(0, 5)));

      const allTop3Below60 = top3Scores.length >= 3 && top3Scores.every(s => s < 60);

      if (!allTop3Below60 || attempt === MAX_ATTEMPTS) {
        if (allTop3Below60 && attempt === MAX_ATTEMPTS) {
          console.log(`[Layer 3] Attempts exhausted — using best available (scores: ${top3Scores.join(', ')})`);
        } else {
          console.log(`[Layer 3] Quality OK — top scores: ${top3Scores.join(', ')}`);
        }
        break;
      }

      // Trigger re-search with alternative tags
      console.log(`[Layer 3] Top 3 all below 60 (${top3Scores.join(', ')}) — re-searching (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      isRefining = true;
      session.searchAttempts += 1;

      const altTags = (evaluation.alternativeTags || []).filter(t => !currentSearchParams.tags?.includes(t));
      if (altTags.length > 0) {
        currentSearchParams = { ...currentSearchParams, tags: altTags, searchAll: false };
      } else {
        currentSearchParams = { ...currentSearchParams, tags: [], searchAll: true };
      }
    }

    // ── Layer 4: Final Recommendation ───────────────────────────
    console.log('[Layer 4] Generating final picks with reasoning...');

    // Pre-sort products by evaluation score so ranker sees best candidates first
    const scoredIndexed = (evaluation?.scores || [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map(s => products[s.productIndex - 1])
      .filter(Boolean);

    const productPool = scoredIndexed.length > 0 ? scoredIndexed : products;

    // For gift mode, use recipient profile as the "person" for ranking
    const rankingProfile = session.personProfile.isGift
      ? { ...session.personProfile, ...session.recipientProfile }
      : session.personProfile;

    const ranking = await rankProducts(productPool, rankingProfile, message, usedFallback);
    console.log(`[Layer 4] Final picks: ${ranking.picks.map(p => `#${p.productIndex}(${p.matchScore}%)`).join(', ')}`);

    const pickedProducts = ranking.picks
      .map(pick => {
        const product = productPool[pick.productIndex - 1];
        if (!product) {
          console.warn(`Bad productIndex ${pick.productIndex}, pool length ${productPool.length}`);
          return null;
        }
        return {
          ...pick,
          product: {
            id: product.id,
            title: product.title,
            price: product.variants[0]?.price || '0.00',
            variantId: product.variants[0]?.id,
            tags: product.tags,
            description: product.body_html?.replace(/<[^>]*>/g, '').slice(0, 200),
            url: `https://${SHOP}/products/${product.handle}`
          }
        };
      })
      .filter(Boolean);

    // Update session history
    session.history.push({ role: 'user', content: message });
    session.history.push({
      role: 'assistant',
      content: `${ranking.summary} Recommended: ${pickedProducts.map(p => p.product.title).join(', ')}`
    });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    return res.json({
      type: 'results',
      mode: analysis.mode,
      summary: ranking.summary,
      followUpQuestion: ranking.followUpQuestion,
      picks: pickedProducts,
      isRefining
    });

  } catch (err) {
    console.error(`[${sessionId}] Chat error:`, err.message);
    console.error(err.stack);
    return res.status(500).json({ error: `Something went wrong: ${err.message}` });
  }
});

// ── Cart Route ───────────────────────────────────────────────────
// POST /cart  body: { variantIds: ["gid://shopify/ProductVariant/123", ...] or [123, ...] }
// Returns: { checkoutUrl, cartId? }
app.post('/cart', async (req, res) => {
  const { variantIds } = req.body;
  if (!variantIds || !Array.isArray(variantIds) || variantIds.length === 0) {
    return res.status(400).json({ error: 'variantIds array required' });
  }

  // ── Attempt: Storefront API cartCreate ───────────────────────
  try {
    const lines = variantIds.map(id => ({
      merchandiseId: String(id).startsWith('gid://')
        ? id
        : `gid://shopify/ProductVariant/${id}`,
      quantity: 1
    }));

    const query = `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id checkoutUrl }
          userErrors { field message }
        }
      }
    `;

    const gqlRes = await axios.post(
      `https://${SHOP}/api/2024-01/graphql.json`,
      { query, variables: { input: { lines } } },
      {
        headers: {
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const result = gqlRes.data?.data?.cartCreate;
    if (result?.cart?.checkoutUrl && !result.userErrors?.length) {
      console.log('Cart created via Storefront API:', result.cart.checkoutUrl);
      return res.json({ cartId: result.cart.id, checkoutUrl: result.cart.checkoutUrl });
    }
    console.warn('Storefront API cart failed:', JSON.stringify(result));
  } catch (err) {
    console.warn('Storefront API error, falling back:', err.message);
  }

  // ── Fallback: Shopify universal cart URL ─────────────────────
  // Extract numeric IDs from gid:// format if needed
  const numericIds = variantIds.map(id => {
    const str = String(id);
    return str.startsWith('gid://') ? str.split('/').pop() : str;
  });
  const checkoutUrl = `https://${SHOP}/cart/${numericIds.map(id => `${id}:1`).join(',')}`;
  console.log('Cart fallback URL:', checkoutUrl);
  return res.json({ checkoutUrl, fallback: true });
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', shop: SHOP }));

const PORT = 3001;
app.listen(PORT, () => console.log(`\nIntentBuy backend running on :${PORT}`));
