// Must be first — disables TLS verification for Shopify dev store on macOS
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
  if (!process.env[key]) console.error(`Missing env var: ${key}`);
});

// ── Session memory ───────────────────────────────────────────────
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
      hasAskedClarify: false
    });
  }
  return sessions.get(sessionId);
}

// ── Shopify product fetchers (Admin API) ─────────────────────────
async function fetchProductsByTag(tag) {
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
}

async function fetchAllProducts() {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2024-01/products.json`,
    {
      params: { limit: 250, status: 'active' },
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    }
  );
  return res.data.products;
}

// ── OpenAI caller ────────────────────────────────────────────────
async function callAI(systemPrompt, userMessage, history = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', max_tokens: 1400, messages },
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

// JSON wrapper with automatic retry on parse failure
async function callAIJSON(systemPrompt, userMessage, history = [], fallback) {
  const parse = raw => JSON.parse(raw.replace(/```json|```/g, '').trim());

  const raw = await callAI(systemPrompt, userMessage, history);
  try {
    return parse(raw);
  } catch {
    try {
      const strict = 'Respond with ONLY a valid JSON object. No markdown, no explanation, no code fences.\n\n' + systemPrompt;
      const raw2 = await callAI(strict, userMessage, []);
      return parse(raw2);
    } catch {
      return fallback;
    }
  }
}

// ── Layer 1: Intent to Search Query ─────────────────────────────
async function analyzeIntent(message, session) {
  const { personProfile, recipientProfile, history, hasAskedClarify } = session;

  const system = `You are an AI shopping agent. Extract PRECISE search parameters from the user's message.

Current person profile: ${JSON.stringify(personProfile)}
Current recipient profile: ${JSON.stringify(recipientProfile)}
Clarifying question already asked this session: ${hasAskedClarify}

Available product tags: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

BUDGET EXTRACTION: Extract as a HARD NUMBER (e.g. "under 5000" → 5000, "around 3k" → 3000, "₹3000" → 3000). Set null only if truly unspecified.

GAIT: If running mentioned, extract: "flat" | "neutral" | "high-arch" | null

GIFT FIELDS: When isGift=true, extract ALL available from the message:
  relationship: "dad" | "mom" | "friend" | "colleague" | null
  age: number or null
  gender: "male" | "female" | null
  lifestyle: "active" | "sedentary" | "busy" | null
  occasion: "birthday" | "anniversary" | "general" | null
  interests: array of strings (e.g. ["yoga", "cooking"])
  constraints: array of strings (e.g. ["hates gym equipment", "allergic to latex"])

SEARCH STRATEGY:
  "targeted" — you have enough info to search specific tags confidently
  "broad" — request is too open-ended, needs all products or a clarifying question

PRIMARY + SECONDARY CATEGORIES: Best category guess from available tags, and additional ones for gifts or bundles.

NONSENSE DETECTION: If input has no shopping intent (random chars, off-topic, single letters), set isNonsense=true.

CLARIFYING QUESTION RULES — at most ONE, ONLY if hasAskedClarify=false:
  1. Budget missing AND category completely unclear → ask budget range
  2. Clearly a GIFT AND recipient age/gender unknown → ask both in one question
  3. Running shoes mentioned AND foot type unknown → ask foot type (flat/neutral/high arch)
  4. Enough info to search meaningfully → clarifyQuestion = null, proceed immediately

Respond ONLY with valid JSON:
{
  "isNonsense": false,
  "searchParams": {
    "tags": ["running"],
    "budget": 5000,
    "useCase": "stability running shoes for flat feet on road",
    "category": "running",
    "searchAll": false
  },
  "searchStrategy": "targeted",
  "primaryCategory": "running",
  "secondaryCategories": [],
  "gait": "flat",
  "isGift": false,
  "mode": "SINGLE",
  "recipientProfileUpdate": null,
  "personProfileUpdate": { "goal": "running" },
  "clarifyQuestion": null,
  "clarifyOptions": null
}`;

  return callAIJSON(system, message, history.slice(-6), {
    isNonsense: false,
    searchParams: { tags: [], budget: null, useCase: '', category: '', searchAll: true },
    searchStrategy: 'broad',
    primaryCategory: '',
    secondaryCategories: [],
    gait: null,
    isGift: false,
    mode: 'SINGLE',
    recipientProfileUpdate: null,
    personProfileUpdate: {},
    clarifyQuestion: null,
    clarifyOptions: null
  });
}

// ── Layer 3: Quality Evaluation ──────────────────────────────────
async function evaluateProducts(products, searchParams, session) {
  if (products.length === 0) return { scores: [], alternativeTags: [] };

  const profile = session.personProfile.isGift ? session.recipientProfile : session.personProfile;
  const budget = searchParams.budget;

  const productList = products.slice(0, 30).map((p, i) => {
    const tags = p.tags.split(',').map(t => t.trim()).join(', ');
    const price = parseFloat(p.variants[0]?.price || '0');
    const desc = p.body_html?.replace(/<[^>]*>/g, '').slice(0, 100) || '';
    return `${i + 1}. ${p.title} | ₹${price} | Tags: ${tags} | ${desc}`;
  }).join('\n');

  const system = `You are a product quality evaluator for an AI shopping agent.

User profile: ${JSON.stringify(profile)}
Use case: "${searchParams.useCase || 'general shopping'}"
Hard budget limit: ${budget ? `₹${budget} — mark anything above this as disqualified` : 'not specified'}
Gift mode: ${session.personProfile.isGift ? 'YES — weight recipient profile match heavily' : 'NO'}

EVALUATION RULES:
1. Any product priced ABOVE the budget limit: score = 0, disqualified = true, brief = "Over budget"
2. Score remaining products 0-100 by:
   - Category relevance (30%): Does the product type match what was asked?
   - Use case match (40%): Does this product solve the specific need described?
   - Recipient/person fit (30%): Does this match the person's lifestyle, age, goals?
   For gift mode: weight recipient fit at 50%.

3. Score bands:
   90-100: Exact fit — every dimension aligns
   70-89: Good fit — core need met, minor gaps
   50-69: Partial — relevant but key need not fully met
   30-49: Weak — tangentially related
   0-29: Wrong category or misses the point

4. brief must be SPECIFIC to THIS product vs THIS need. No generic phrases.
   Good: "Stability foam corrects overpronation — matches flat foot gait"
   Bad: "Great for active people"

If ALL non-disqualified top 3 scores are below 60, list alternativeTags to try next.
Available tags: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

Respond ONLY with valid JSON:
{
  "scores": [
    { "productIndex": 1, "score": 85, "disqualified": false, "brief": "Stability foam corrects overpronation" }
  ],
  "alternativeTags": []
}`;

  return callAIJSON(system, productList, [], {
    scores: products.slice(0, 10).map((_, i) => ({ productIndex: i + 1, score: 55, disqualified: false, brief: '' })),
    alternativeTags: []
  });
}

// ── Layer 4: Final Recommendation ───────────────────────────────
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

  const diversityRule = availableCats.length >= 3
    ? `DIVERSITY: Pick from 3 different [CAT:...] categories — no two from the same. ${(isGiftOrOpen && nonShoeCats.length >= 2) ? 'At most 1 shoe pick (CAT: running/casual/formal/training/trail/gym).' : ''}`
    : 'Pick the 3 most relevant products for this person.';

  const fallbackNote = usedFallback
    ? 'The exact category is not in the catalog — pick closest alternatives and acknowledge this briefly in the summary.'
    : '';

  const system = `You are a personal shopping advisor for IntentBuy. Think of yourself as a knowledgeable friend who knows exactly what this person needs.

User profile: ${JSON.stringify(personProfile)}
Request: "${userMessage}"
${diversityRule}
${fallbackNote}

Pick the TOP 3 products. Each must serve a genuinely different angle or need — not just different brands.

REASONING QUALITY (this is what wins the user's trust):
- reason: Reference THIS product's specific features vs THIS person's specific situation.
  Good: "The Dynamic Support system corrects overpronation — exactly what flat feet need on long runs"
  Bad: "Good for running"
- tradeoff: Be honest and concrete. Name a real limitation.
  Good: "At ₹4499 it's near your ₹5000 ceiling — leaves little room for socks or accessories"
  Bad: "May not suit everyone"
- summary: Sound like a trusted friend who just did the research. Mention the variety you picked and WHY each covers a different angle. 2 sentences max.

Return ONLY valid JSON:
{
  "picks": [{ "rank": 1, "productIndex": 3, "matchScore": 91, "reason": "...", "tradeoff": "..." }],
  "summary": "...",
  "followUpQuestion": null
}
productIndex is 1-based. followUpQuestion only if it would meaningfully improve picks, else null.`;

  return callAIJSON(system, productList, [], {
    picks: [],
    summary: "Here are some options for you.",
    followUpQuestion: null
  });
}

// ── Main Chat Route ──────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const session = getSession(sessionId);

  try {
    // ── Layer 1: Intent to Search Query ─────────────────────────
    let analysis;
    try {
      analysis = await analyzeIntent(message, session);
    } catch (err) {
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    if (analysis.isNonsense) {
      return res.json({
        type: 'no_results',
        message: "I didn't quite get that. Try describing what you need, like \"running shoes under ₹3000\" or \"gift for my mom\"."
      });
    }

    // Update profiles
    if (analysis.personProfileUpdate && Object.keys(analysis.personProfileUpdate).length) {
      session.personProfile = { ...session.personProfile, ...analysis.personProfileUpdate };
    }
    if (analysis.isGift) session.personProfile.isGift = true;

    if (analysis.isGift && analysis.recipientProfileUpdate) {
      const u = analysis.recipientProfileUpdate;
      session.recipientProfile = {
        ...session.recipientProfile,
        ...u,
        interests: [...new Set([...(session.recipientProfile.interests || []), ...(u.interests || [])])],
        constraints: [...new Set([...(session.recipientProfile.constraints || []), ...(u.constraints || [])])]
      };
    }

    // Budget floor check
    const earlyBudget = analysis.isGift
      ? (session.recipientProfile.budget || analysis.searchParams.budget)
      : analysis.searchParams.budget;
    if (earlyBudget && earlyBudget < 200) {
      const msg = `Our products start at ₹200 — with a budget of ₹${earlyBudget} I won't find anything. Try at least ₹500 to see great options.`;
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: msg });
      return res.json({ type: 'no_results', message: msg });
    }

    // Smart single clarifying question — hard session guard prevents repeat
    if (analysis.clarifyQuestion && !session.hasAskedClarify) {
      session.hasAskedClarify = true;
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: analysis.clarifyQuestion });
      return res.json({
        type: 'question',
        question: analysis.clarifyQuestion,
        options: analysis.clarifyOptions || null
      });
    }

    // ── Layers 2 + 3: Fetch & Evaluate with re-search loop ───────
    let products = [];
    let usedFallback = false;
    let evaluation = null;
    let currentSearchParams = { ...analysis.searchParams };
    let isRefining = false;
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ── Layer 2: Shopify Fetch (Admin API) ─────────────────────
      try {
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
            fetched = await fetchAllProducts();
            usedFallback = true;
          }
        }
        products = fetched;
      } catch (err) {
        return res.json({
          type: 'no_results',
          message: 'Our product catalog is temporarily unavailable. Please try again in a moment.'
        });
      }

      // Budget filter
      const budget = analysis.isGift
        ? (session.recipientProfile.budget || currentSearchParams.budget)
        : currentSearchParams.budget;

      if (budget) {
        const withinBudget = products.filter(p => parseFloat(p.variants[0]?.price) <= budget);
        if (withinBudget.length > 0) {
          products = withinBudget;
        } else if (attempt === MAX_ATTEMPTS) {
          const minPrice = Math.min(...products.map(p => parseFloat(p.variants[0]?.price) || 99999));
          const msg = `I don't have anything under ₹${budget.toLocaleString('en-IN')} right now. The most affordable options start at ₹${minPrice.toLocaleString('en-IN')}. Want me to show you the best picks around that price?`;
          session.history.push({ role: 'user', content: message });
          session.history.push({ role: 'assistant', content: msg });
          return res.json({ type: 'no_results', message: msg });
        }
      }

      // ── Layer 3: Quality Evaluation ───────────────────────────
      try {
        evaluation = await evaluateProducts(products, currentSearchParams, session);
      } catch {
        evaluation = { scores: [], alternativeTags: [] };
      }

      // Filter disqualified (over-budget) products from scores
      const qualifiedScores = (evaluation.scores || []).filter(s => !s.disqualified);
      const sortedScores = qualifiedScores.sort((a, b) => b.score - a.score);
      const top3Scores = sortedScores.slice(0, 3).map(s => s.score);
      const allTop3Below60 = top3Scores.length >= 3 && top3Scores.every(s => s < 60);

      if (!allTop3Below60 || attempt === MAX_ATTEMPTS) {
        if (allTop3Below60 && isRefining) {
          const msg = "I searched a few different ways but couldn't find a great match. Try being more specific — mention a category, budget, or use case and I'll look again.";
          session.history.push({ role: 'user', content: message });
          session.history.push({ role: 'assistant', content: msg });
          return res.json({ type: 'no_results', message: msg });
        }
        break;
      }

      if (currentSearchParams.searchAll) break;

      isRefining = true;
      const altTags = (evaluation.alternativeTags || []).filter(t => !currentSearchParams.tags?.includes(t));
      currentSearchParams = altTags.length > 0
        ? { ...currentSearchParams, tags: altTags, searchAll: false }
        : { ...currentSearchParams, tags: [], searchAll: true };
    }

    // ── Layer 4: Final Recommendation ───────────────────────────
    // Use qualified (non-disqualified) products sorted by score
    const qualifiedScoresSorted = (evaluation?.scores || [])
      .filter(s => !s.disqualified)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map(s => products[s.productIndex - 1])
      .filter(Boolean);

    const productPool = qualifiedScoresSorted.length > 0 ? qualifiedScoresSorted : products;

    const rankingProfile = session.personProfile.isGift
      ? { ...session.personProfile, ...session.recipientProfile }
      : session.personProfile;

    let ranking;
    try {
      ranking = await rankProducts(productPool, rankingProfile, message, usedFallback);
    } catch {
      return res.status(500).json({ error: 'Something went wrong generating recommendations. Please try again.' });
    }

    const pickedProducts = ranking.picks
      .map(pick => {
        const product = productPool[pick.productIndex - 1];
        if (!product) return null;
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
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Cart Route (Storefront API + fallback) ───────────────────────
app.post('/cart', async (req, res) => {
  const { variantIds } = req.body;
  if (!variantIds || !Array.isArray(variantIds) || variantIds.length === 0) {
    return res.status(400).json({ error: 'variantIds array required' });
  }

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
      return res.json({ cartId: result.cart.id, checkoutUrl: result.cart.checkoutUrl });
    }
  } catch (err) {
    // fall through to URL fallback
  }

  // Fallback: universal Shopify cart URL — works for single and multiple items
  const cartPath = variantIds
    .map(id => {
      const numericId = String(id).includes('gid://')
        ? String(id).split('/').pop()
        : String(id);
      return `${numericId}:1`;
    })
    .join(',');
  const checkoutUrl = `https://${SHOP}/cart/${cartPath}`;
  return res.json({ checkoutUrl, fallback: true });
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', shop: SHOP }));

const PORT = 3001;
app.listen(PORT, () => console.log(`IntentBuy backend running on :${PORT}`));
