require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Title → price lookup from seed data
const priceMap = {
  "Nike Air Zoom Pegasus 40": "4999",
  "Adidas Ultraboost 23": "7999",
  "Brooks Adrenaline GTS 23": "5499",
  "ASICS Gel-Kayano 30": "6999",
  "Saucony Kinvara 14": "3999",
  "New Balance Fresh Foam 1080v13": "6499",
  "Hoka Clifton 9": "5999",
  "Puma Velocity Nitro 2": "2999",
  "Reebok Floatride Energy 5": "2499",
  "Nike Structure 25": "4499",
  "Adidas Stan Smith": "3499",
  "Nike Air Force 1": "4999",
  "Converse Chuck Taylor All Star": "2499",
  "Puma Suede Classic": "2999",
  "Vans Old Skool": "3499",
  "New Balance 574": "3999",
  "Adidas Gazelle": "3999",
  "Campus Shoes Derby Formal": "899",
  "Bata Senator Oxford": "1499",
  "Red Tape Formal Brogue": "2499",
  "Clarks Tilden Cap": "3999",
  "Nike Metcon 9": "5499",
  "Adidas Powerlift 5": "4499",
  "Reebok Nano X3": "4999",
  "Under Armour HOVR Rise 4": "3999",
  "Puma Tazon 7": "1999",
  "Nike Wildhorse 7": "4999",
  "Salomon Speedcross 6": "7499",
  "Woodland Casual Oxford": "2499",
  "Sparx Sports Running Shoe": "899",
  "HRX by Hrithik Roshan Runner": "1499",
  "Adidas Duramo SL": "2499",
  "Nike Revolution 7": "2999",
  "ASICS Gel-Nimbus 25": "7499",
  "Fila Ranger Trail": "1799",
};

async function fetchAllProducts() {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2024-01/products.json`,
    {
      params: { limit: 250, status: 'active' },
      headers: { 'X-Shopify-Access-Token': TOKEN }
    }
  );
  return res.data.products;
}

async function updateVariantPrice(variantId, price) {
  await axios.put(
    `https://${SHOP}/admin/api/2024-01/variants/${variantId}.json`,
    { variant: { id: variantId, price } },
    { headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function fixPrices() {
  console.log('Fetching all products...');
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products\n`);

  let fixed = 0;
  let skipped = 0;

  for (const product of products) {
    const price = priceMap[product.title];
    if (!price) {
      console.log(`⚠️  No price mapping for: ${product.title}`);
      skipped++;
      continue;
    }

    const currentPrice = product.variants[0]?.price;
    if (parseFloat(currentPrice) > 0) {
      console.log(`✓  Already priced: ${product.title} @ ₹${currentPrice}`);
      skipped++;
      continue;
    }

    try {
      for (const variant of product.variants) {
        await updateVariantPrice(variant.id, price);
        await new Promise(r => setTimeout(r, 200));
      }
      console.log(`✅ Fixed: ${product.title} → ₹${price}`);
      fixed++;
    } catch (err) {
      console.log(`❌ Failed: ${product.title} — ${err.response?.data?.errors || err.message}`);
    }
  }

  console.log(`\nDone! Fixed ${fixed} products, skipped ${skipped}.`);
}

fixPrices().catch(console.error);
