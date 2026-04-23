// Publishes all products to the Online Store (required for Storefront API access)
require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function fetchAllProducts() {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2024-01/products.json`,
    { params: { limit: 250 }, headers: { 'X-Shopify-Access-Token': TOKEN } }
  );
  return res.data.products;
}

async function publishProducts() {
  console.log('Fetching all products...');
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products. Publishing...\n`);

  let published = 0;
  for (const p of products) {
    try {
      await axios.put(
        `https://${SHOP}/admin/api/2024-01/products/${p.id}.json`,
        { product: { id: p.id, published: true } },
        { headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' } }
      );
      console.log(`✅ Published: ${p.title}`);
      published++;
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.log(`❌ Failed: ${p.title} — ${err.response?.data?.errors || err.message}`);
    }
  }
  console.log(`\nDone! Published ${published}/${products.length} products.`);
}

publishProducts().catch(console.error);
