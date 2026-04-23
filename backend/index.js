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

// Validate required env vars at startup
['SHOPIFY_STORE_URL', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_STOREFRONT_TOKEN', 'OPENAI_API_KEY'].forEach(key => {
  if (!process.env[key]) console.error(`⚠️  Missing env var: ${key}`);
  else console.log(`✓ ${key} loaded (${process.env[key].slice(0, 8)}...)`);
});

// ── Session memory ───────────────────────────────────────────────
// sessions[sessionId] = { history: [{role,content}], personProfile: {} }
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], personProfile: {} });
  }
  return sessions.get(sessionId);
}

// ── Shopify product fetchers ─────────────────────────────────────
async function fetchProductsByTag(tag, limit = 20) {
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

// ── Person-Centered Profile Builder ─────────────────────────────
// Builds a rich profile from conversation, not just keywords
async function buildPersonProfile(message, existingProfile, history) {
  const system = `You are an empathetic shopping agent that understands the PERSON behind every request.

Given the user's message and any existing profile, produce an updated person profile.

Think beyond keywords. "Gift for my tired dad who wants better health" reveals:
- recipient: dad, age ~50s, lifestyle: likely sedentary/busy, goal: health improvement, emotional state: tired/stressed

From the profile, decide what product CATEGORIES to search (can be multiple):
Available tags in store: running, casual, formal, training, trail, fitness, wellness, yoga, gym, recovery

Rules:
- For gifts: focus on recipient's profile, not buyer's
- Budget means TOTAL budget across all picks
- For open-ended or luxurious gifts with no specific category: set searchAll=true so the ranker can pick diverse options
- If user says "home gym" → search fitness + training + gym
- If user wants "wellness" → search wellness + recovery + fitness
- If buying for "tired/stressed person" → recovery + wellness + casual
- If "luxurious" or "birthday" with no category specified → searchAll=true
- Do NOT assume shoes unless explicitly mentioned

Existing profile: ${JSON.stringify(existingProfile)}

Respond ONLY with JSON:
{
  "personProfile": {
    "isGift": false,
    "recipient": null,
    "recipientAge": null,
    "recipientLifestyle": null,
    "goal": null,
    "occasion": null,
    "budget": null,
    "gait": null,
    "constraints": [],
    "emotionalContext": null
  },
  "searchTags": ["running", "fitness"],
  "searchAll": false,
  "mode": "SINGLE",
  "missingInfo": null,
  "clarifyQuestion": null
}

searchAll = true means search entire catalog.
mode: SINGLE | BUNDLE | GIFT
missingInfo: most important missing field or null
clarifyQuestion: a natural follow-up question if needed, else null
clarifyOptions: if clarifyQuestion is set, provide 5-7 short, tappable answer options that cover the likely responses. Example: for "What kind of wellness does your mom enjoy?" → ["Yoga & stretching", "Massage & recovery", "Walking & running", "Better sleep", "General fitness", "Not sure"]. Keep each option under 4 words if possible. Set to null if no clarifyQuestion.`;

  const raw = await callAI(system, message, history.slice(-6));
  return safeParseJSON(raw, {
    personProfile: {},
    searchTags: [],
    searchAll: true,
    mode: 'SINGLE',
    missingInfo: null,
    clarifyQuestion: null,
    clarifyOptions: null
  });
}

// ── Product Ranker ───────────────────────────────────────────────
async function rankProducts(products, personProfile, userMessage, usedFallback = false) {
  if (products.length === 0) return { picks: [], summary: "No products found.", followUpQuestion: null };

  const capped = products.slice(0, 40);

  // Extract the primary category for each product so the AI can reason about diversity
  const KNOWN_CATS = ['running','casual','formal','training','trail','fitness','wellness','yoga','gym','recovery'];
  const productList = capped.map((p, i) => {
    const tags = p.tags.split(',').map(t => t.trim());
    const primaryCat = KNOWN_CATS.find(c => tags.includes(c)) || tags[0] || 'other';
    return `${i + 1}. [CAT:${primaryCat}] ${p.title} — ₹${p.variants[0]?.price || '?'} — ${p.body_html?.replace(/<[^>]*>/g, '').slice(0, 100)}`;
  }).join('\n');

  // Check how many distinct categories are available
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

Return ONLY JSON (no markdown):
{
  "picks": [
    {
      "rank": 1,
      "productIndex": 3,
      "matchScore": 91,
      "reason": "Perfect because... (1-2 sentences, be specific to their situation)",
      "tradeoff": "Worth noting..."
    }
  ],
  "summary": "Here's what I found — [2 sentences, mention the variety of options and why each serves a different need]",
  "followUpQuestion": null
}
productIndex is the 1-based number from the list.
followUpQuestion: only if a specific question would meaningfully improve the picks, else null.`;

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
    // Step 1: Build person profile from message + history
    const analysis = await buildPersonProfile(message, session.personProfile, session.history);
    console.log(`[${sessionId}] Profile:`, JSON.stringify(analysis.personProfile));
    console.log(`[${sessionId}] Search tags:`, analysis.searchTags, '| searchAll:', analysis.searchAll);

    // Update stored person profile
    session.personProfile = { ...session.personProfile, ...analysis.personProfile };

    // Step 2: Ask clarifying question if critical info missing
    if (analysis.clarifyQuestion && analysis.missingInfo) {
      session.history.push({ role: 'user', content: message });
      session.history.push({ role: 'assistant', content: analysis.clarifyQuestion });
      return res.json({
        type: 'question',
        question: analysis.clarifyQuestion,
        options: analysis.clarifyOptions || null
      });
    }

    // Step 3: Fetch products — always fall back to full catalog if tag search is empty
    let products = [];
    let usedFallback = false;

    if (analysis.searchAll || analysis.searchTags.length === 0) {
      products = await fetchAllProducts();
    } else {
      const tagFetches = await Promise.all(
        analysis.searchTags.map(tag => fetchProductsByTag(tag, 20))
      );
      const seen = new Set();
      for (const batch of tagFetches) {
        for (const p of batch) {
          if (!seen.has(p.id)) { seen.add(p.id); products.push(p); }
        }
      }
      // If the requested category has no products in our store, fall back to full catalog
      // so the AI can pick the closest alternative rather than saying "no results"
      if (products.length === 0) {
        console.log(`[${sessionId}] No products for tags [${analysis.searchTags}] — falling back to full catalog`);
        products = await fetchAllProducts();
        usedFallback = true;
      }
    }

    console.log(`[${sessionId}] Products fetched: ${products.length}${usedFallback ? ' (full catalog fallback)' : ''}`);

    // Step 4: Budget filter — only apply if it meaningfully reduces the set
    const budget = analysis.personProfile.budget;
    if (budget) {
      const withinBudget = products.filter(p => parseFloat(p.variants[0]?.price) <= budget);
      console.log(`[${sessionId}] After budget filter (≤₹${budget}): ${withinBudget.length}`);
      if (withinBudget.length > 0) {
        products = withinBudget;
      } else {
        // Budget is too low for anything — tell user clearly with accurate min price
        const minPrice = Math.min(...products.map(p => parseFloat(p.variants[0]?.price) || 99999));
        const noResultMsg = `I don't have anything under ₹${budget.toLocaleString('en-IN')} right now. The most affordable options start at ₹${minPrice.toLocaleString('en-IN')}. Want me to show you the best picks around that price?`;
        session.history.push({ role: 'user', content: message });
        session.history.push({ role: 'assistant', content: noResultMsg });
        return res.json({ type: 'no_results', message: noResultMsg });
      }
    }

    // Step 5: AI ranks products against person profile
    const ranking = await rankProducts(products, session.personProfile, message, usedFallback);
    console.log(`[${sessionId}] Picks: ${ranking.picks.map(p => p.productIndex).join(', ')}`);

    // Step 6: Build response with full product details
    const pickedProducts = ranking.picks
      .map(pick => {
        const product = products[pick.productIndex - 1];
        if (!product) { console.warn(`Bad productIndex ${pick.productIndex}, products length ${products.length}`); return null; }
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
      picks: pickedProducts
    });

  } catch (err) {
    console.error(`[${sessionId}] Chat error:`, err.message);
    console.error(err.stack);
    return res.status(500).json({ error: `Something went wrong: ${err.message}` });
  }
});

// ── Cart Route ───────────────────────────────────────────────────
// POST /cart  body: { variantIds: [id, id, ...] }
// Returns:    { checkoutUrl }
//
// Strategy: try Storefront API cartCreate first (gives a proper checkout session).
// If that fails (common on dev stores with channel-publishing issues), fall back
// to Shopify's universal cart URL which works without any channel setup.
app.post('/cart', async (req, res) => {
  const { variantIds } = req.body;
  if (!variantIds || !Array.isArray(variantIds) || variantIds.length === 0) {
    return res.status(400).json({ error: 'variantIds array required' });
  }

  // ── Attempt 1: Storefront API cartCreate ──────────────────────
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
    console.warn('Storefront API cart error, falling back:', err.message);
  }

  // ── Fallback: Shopify universal cart URL ──────────────────────
  // Format: https://shop.myshopify.com/cart/VARIANT_ID:qty,VARIANT_ID:qty
  // Works on all Shopify stores without any channel publishing setup.
  const cartItems = variantIds.map(id => `${id}:1`).join(',');
  const checkoutUrl = `https://${SHOP}/cart/${cartItems}`;
  console.log('Cart fallback URL:', checkoutUrl);
  return res.json({ checkoutUrl, fallback: true });
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', shop: SHOP }));

const PORT = 3001;
app.listen(PORT, () => console.log(`\nIntentBuy backend running on :${PORT}`));
