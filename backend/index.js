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

// ── Shopify product fetchers ─────────────────────────────────────
// Both throw on error so the caller can surface a catalog-unavailable message.
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

// Wraps callAI with JSON parse + one automatic retry on parse failure.
// Throws only on API-level failures (bad key, network down).
// Returns fallback only when the model consistently returns malformed JSON.
async function callAIJSON(systemPrompt, userMessage, history = [], fallback) {
  const parseJSON = raw => JSON.parse(raw.replace(/```json|```/g, '').trim());

  // First attempt
  const raw = await callAI(systemPrompt, userMessage, history); // throws on API error

  try {
    return parseJSON(raw);
  } catch {
    // JSON parse failed — retry once with an explicit JSON-only instruction
    try {
      const strictSystem = 'You must respond with ONLY a valid JSON object. No markdown, no explanation, no code fences. Raw JSON only.\n\n' + systemPrompt;
      const raw2 = await callAI(strictSystem, userMessage, []);
      return parseJSON(raw2);
    } catch {
      console.error('JSON parse failed after retry, using fallback');
      return fallback;
    }
  }
}

// ── Layer 1: Intent to Search Query ─────────────────────────────
async function analyzeIntent(message, session) {
  const { personProfile, recipientProfile, history, hasAskedClarify } = session;

  const system = `You are an AI shopping agent. Analyze the user's message and produce structured search parameters.

Current person profile: ${JSON.stringify(personProfile)}
Current recipient profile: ${JSON.stringify(recipientProfile)}
Clarifying question already asked this session: ${hasAskedClarify}

Available product tags: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

NONSENSE DETECTION: If the input has no shopping intent (random characters, completely off-topic, single letters) set isNonsense=true.

CLARIFYING QUESTION RULES — at most ONE, and ONLY if hasAskedClarify=false:
1. Budget missing AND category completely unclear → ask about budget range
2. Clearly a GIFT AND recipient age/gender unknown → ask age + gender in one question
3. Running shoes mentioned AND foot type unknown → ask foot type (flat/neutral/high arch)
4. Enough info to search meaningfully → set clarifyQuestion to null

GIFT PROFILE: When isGift=true, populate recipientProfileUpdate from anything in the message:
{ occasion, relationship, age, gender, lifestyle (active/sedentary/busy), interests (array), budget, constraints (array) }

SEARCH PARAMS:
- tags: from the available tags list above
- budget: numeric INR or null
- useCase: brief description of need (empty if nonsense)
- searchAll: true for broad or gift-with-no-category requests
- category: primary category name

MODE: SINGLE | BUNDLE | GIFT

Respond ONLY with valid JSON:
{
  "isNonsense": false,
  "searchParams": { "tags": [], "budget": null, "useCase": "", "category": "", "searchAll": true },
  "isGift": false,
  "mode": "SINGLE",
  "recipientProfileUpdate": null,
  "personProfileUpdate": {},
  "clarifyQuestion": null,
  "clarifyOptions": null
}`;

  return callAIJSON(system, message, history.slice(-6), {
    isNonsense: false,
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
async function evaluateProducts(products, searchParams, session) {
  if (products.length === 0) return { scores: [], alternativeTags: [] };

  const profile = session.personProfile.isGift ? session.recipientProfile : session.personProfile;

  const productList = products.slice(0, 30).map((p, i) => {
    const tags = p.tags.split(',').map(t => t.trim()).join(', ');
    const price = p.variants[0]?.price || '?';
    const desc = p.body_html?.replace(/<[^>]*>/g, '').slice(0, 100) || '';
    return `${i + 1}. ${p.title} | ₹${price} | Tags: ${tags} | ${desc}`;
  }).join('\n');

  const system = `You are a product quality evaluator.

User profile: ${JSON.stringify(profile)}
Use case: "${searchParams.useCase || 'general shopping'}"
Budget: ${searchParams.budget ? `₹${searchParams.budget}` : 'not specified'}

Score each product 0-100 on fit with user needs:
90-100: Perfect | 70-89: Good | 50-69: Partial | 30-49: Weak | 0-29: Poor

If ALL top 3 scores are below 60, list alternativeTags to try next (from: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery).

Respond ONLY with valid JSON:
{
  "scores": [{ "productIndex": 1, "score": 85, "brief": "Good fit" }],
  "alternativeTags": []
}`;

  return callAIJSON(system, productList, [], {
    scores: products.slice(0, 10).map((_, i) => ({ productIndex: i + 1, score: 55, brief: '' })),
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
    ? `DIVERSITY RULE: Pick from 3 different [CAT:...] categories — no two picks same category. ${(isGiftOrOpen && nonShoeCats.length >= 2) ? 'At most 1 shoe pick (running/casual/formal/training/trail/gym).' : ''}`
    : 'Pick the 3 most relevant products.';

  const fallbackNote = usedFallback
    ? 'Note: exact category not in catalog — pick closest alternatives and acknowledge naturally.'
    : '';

  const system = `You are an expert shopping advisor for IntentBuy.
User profile: ${JSON.stringify(personProfile)}
Request: "${userMessage}"
${diversityRule}
${fallbackNote}

Pick TOP 3 from the list. Each serves a different purpose or angle.

Return ONLY valid JSON:
{
  "picks": [{ "rank": 1, "productIndex": 3, "matchScore": 91, "reason": "...", "tradeoff": "..." }],
  "summary": "2 sentences: what you found and why the variety serves different needs",
  "followUpQuestion": null
}
productIndex is 1-based. followUpQuestion: only if it meaningfully improves picks, else null.`;

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
      console.error('Layer 1 failed:', err.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    // Nonsensical input — no shopping intent detected
    if (analysis.isNonsense) {
      return res.json({
        type: 'no_results',
        message: "I didn't quite get that. Try describing what you need, like \"running shoes under ₹3000\" or \"gift for my mom\"."
      });
    }

    // Update profiles from this message
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

    // Budget floor check — catch impossibly low budgets before searching
    const earlyBudget = analysis.isGift
      ? (session.recipientProfile.budget || analysis.searchParams.budget)
      : analysis.searchParams.budget;
    if (earlyBudget && earlyBudget < 200) {
      const msg = `Our products start at ₹200 — with a budget of ₹${earlyBudget} I won't be able to find anything. Try a budget of at least ₹500 to see some great options.`;
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
    const MAX_ATTEMPTS = 3; // initial + up to 2 re-searches

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // ── Layer 2: Shopify Fetch ─────────────────────────────────
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
        console.error('Shopify fetch error:', err.message);
        return res.json({
          type: 'no_results',
          message: 'Our product catalog is temporarily unavailable. Please try again in a moment.'
        });
      }

      // Budget filter — use recipient budget for gifts, user budget otherwise
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
        // else: budget found nothing this attempt, let re-search try different tags
      }

      // ── Layer 3: Quality Evaluation ───────────────────────────
      try {
        evaluation = await evaluateProducts(products, currentSearchParams, session);
      } catch (err) {
        console.error('Layer 3 failed:', err.message);
        // Fallback: treat all products as moderate quality and proceed
        evaluation = { scores: [], alternativeTags: [] };
      }

      const sortedScores = [...(evaluation.scores || [])].sort((a, b) => b.score - a.score);
      const top3Scores = sortedScores.slice(0, 3).map(s => s.score);
      const allTop3Below60 = top3Scores.length >= 3 && top3Scores.every(s => s < 60);

      if (!allTop3Below60 || attempt === MAX_ATTEMPTS) {
        // If we exhausted all re-searches and quality is still poor, stop and be honest
        if (allTop3Below60 && isRefining) {
          const msg = "I searched a few different ways but couldn't find a great match for what you described. Try being more specific — mention a category, budget, or use case and I'll look again.";
          session.history.push({ role: 'user', content: message });
          session.history.push({ role: 'assistant', content: msg });
          return res.json({ type: 'no_results', message: msg });
        }
        break;
      }

      // Trigger re-search with alternative tags
      // If we're already searching the full catalog, no point re-searching
      if (currentSearchParams.searchAll) break;

      isRefining = true;
      const altTags = (evaluation.alternativeTags || []).filter(t => !currentSearchParams.tags?.includes(t));
      currentSearchParams = altTags.length > 0
        ? { ...currentSearchParams, tags: altTags, searchAll: false }
        : { ...currentSearchParams, tags: [], searchAll: true };
    }

    // ── Layer 4: Final Recommendation ───────────────────────────
    // Pre-sort by evaluation score so the ranker sees best candidates first
    const scoredIndexed = (evaluation?.scores || [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map(s => products[s.productIndex - 1])
      .filter(Boolean);

    const productPool = scoredIndexed.length > 0 ? scoredIndexed : products;
    const rankingProfile = session.personProfile.isGift
      ? { ...session.personProfile, ...session.recipientProfile }
      : session.personProfile;

    let ranking;
    try {
      ranking = await rankProducts(productPool, rankingProfile, message, usedFallback);
    } catch (err) {
      console.error('Layer 4 failed:', err.message);
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
    console.error(`Chat error [${sessionId}]:`, err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
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

  // Attempt 1: Storefront API cartCreate (proper checkout session)
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
    console.error('Storefront API cart error:', err.message);
  }

  // Fallback: universal Shopify cart URL — works without sales channel setup
  const numericIds = variantIds.map(id => {
    const str = String(id);
    return str.startsWith('gid://') ? str.split('/').pop() : str;
  });
  const checkoutUrl = `https://${SHOP}/cart/${numericIds.map(id => `${id}:1`).join(',')}?storefront=true`;
  return res.json({ checkoutUrl, fallback: true });
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', shop: SHOP }));

const PORT = 3001;
app.listen(PORT, () => console.log(`IntentBuy backend running on :${PORT}`));
