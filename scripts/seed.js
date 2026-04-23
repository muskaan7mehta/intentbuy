require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Helper: build variants with price embedded
function sizeVariants(sizes, price) {
  return sizes.map(s => ({ option1: s, price }));
}

const shoes = [
  { title: "Nike Air Zoom Pegasus 40", tags: "running,neutral,men,cushioned", body_html: "Best-in-class daily trainer. Ideal for neutral runners who clock 30-50km per week. Lightweight foam midsole with responsive cushioning.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "4999") },
  { title: "Adidas Ultraboost 23", tags: "running,neutral,men,women,premium", body_html: "Premium running shoe with Boost midsole. Exceptional energy return. Good for long distances on road. Neutral gait.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "7999") },
  { title: "Brooks Adrenaline GTS 23", tags: "running,stability,overpronation,men,women", body_html: "Top-rated stability shoe for overpronators. GuideRails support system prevents excess movement. Great for flat feet.", variants: sizeVariants(["UK 6","UK 7","UK 8"], "5499") },
  { title: "ASICS Gel-Kayano 30", tags: "running,stability,overpronation,flat-feet,premium", body_html: "Premium stability trainer for severe overpronators. Gel cushioning in heel and forefoot. Ideal for flat feet runners.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "6999") },
  { title: "Saucony Kinvara 14", tags: "running,neutral,lightweight,speed", body_html: "Lightweight speed trainer for tempo runs and races. Minimal stack height. Best for neutral runners with strong arches.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "3999") },
  { title: "New Balance Fresh Foam 1080v13", tags: "running,neutral,premium,cushioned,long-distance", body_html: "Max cushion for long distance running. Ultra-plush Fresh Foam midsole. For neutral runners who want maximum comfort.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "6499") },
  { title: "Hoka Clifton 9", tags: "running,neutral,max-cushion,recovery", body_html: "Iconic max-cushion shoe. Great for recovery runs and easy days. Neutral support. Wide toe box.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "5999") },
  { title: "Puma Velocity Nitro 2", tags: "running,neutral,budget,men", body_html: "Best budget running shoe with NITRO foam. Lightweight and responsive. Great value for daily training.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "2999") },
  { title: "Reebok Floatride Energy 5", tags: "running,neutral,budget,men,women", body_html: "Affordable daily trainer with Floatride foam. Responsive and lightweight. Budget-friendly option under ₹3000.", variants: sizeVariants(["UK 6","UK 7","UK 8"], "2499") },
  { title: "Nike Structure 25", tags: "running,stability,overpronation,flat-feet,men", body_html: "Nike's best stability shoe. Dynamic Support system corrects overpronation. Good for flat feet runners on road.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "4499") },
  { title: "Adidas Stan Smith", tags: "casual,sneaker,men,women,classic,everyday", body_html: "Iconic leather sneaker. Clean minimal design. Versatile for everyday wear, college, casual outings.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "3499") },
  { title: "Nike Air Force 1", tags: "casual,sneaker,men,women,classic,streetwear", body_html: "Legendary street sneaker. Chunky sole, clean leather upper. Pairs with anything. All-day comfort.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "4999") },
  { title: "Converse Chuck Taylor All Star", tags: "casual,sneaker,men,women,classic,college", body_html: "Timeless canvas sneaker. Lightweight and stylish. Great for college and casual daily wear.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "2499") },
  { title: "Puma Suede Classic", tags: "casual,sneaker,men,retro,everyday", body_html: "Retro suede sneaker. Soft upper, cushioned sole. Good for everyday casual wear.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "2999") },
  { title: "Vans Old Skool", tags: "casual,sneaker,men,women,skate,college", body_html: "Classic skate shoe. Durable canvas and suede upper. Iconic side stripe. College favourite.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "3499") },
  { title: "New Balance 574", tags: "casual,sneaker,men,women,retro,comfort", body_html: "Retro lifestyle sneaker with ENCAP cushioning. Comfortable all-day wear. Versatile styling.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "3999") },
  { title: "Adidas Gazelle", tags: "casual,sneaker,men,women,retro,college", body_html: "Slim retro sneaker with suede upper. Lightweight and stylish. Perfect for college and casual outings.", variants: sizeVariants(["UK 6","UK 7","UK 8"], "3999") },
  { title: "Campus Shoes Derby Formal", tags: "formal,office,men,budget,leather-look", body_html: "Smart Derby formal shoe. Faux leather upper. Lightweight sole. Budget office wear under ₹1000.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "899") },
  { title: "Bata Senator Oxford", tags: "formal,office,men,oxford,classic", body_html: "Classic Oxford formal. Genuine leather upper. Durable Bata quality. Good for office and interviews.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "1499") },
  { title: "Red Tape Formal Brogue", tags: "formal,office,men,brogue,premium-look", body_html: "Stylish brogue formal shoe. Perforated detailing. Comfortable insole. Great for office and events.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "2499") },
  { title: "Clarks Tilden Cap", tags: "formal,office,men,premium,leather", body_html: "Premium Clarks formal. Genuine leather, Ortholite footbed. All-day comfort for office wear.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "3999") },
  { title: "Nike Metcon 9", tags: "training,gym,cross-training,men,women", body_html: "Best gym training shoe. Flat stable base for lifting. Flexible forefoot for cardio. All-round gym use.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "5499") },
  { title: "Adidas Powerlift 5", tags: "training,gym,weightlifting,men,women", body_html: "Dedicated weightlifting shoe. Elevated heel improves squat depth. Stable base for heavy lifts.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "4499") },
  { title: "Reebok Nano X3", tags: "training,gym,cross-training,men,women", body_html: "Versatile cross-training shoe. Good for HIIT, lifting, and cardio. Wide toe box. Durable upper.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "4999") },
  { title: "Under Armour HOVR Rise 4", tags: "training,gym,men,cushioned,cross-training", body_html: "Cushioned training shoe with HOVR foam. Good energy return. Suitable for mixed gym workouts.", variants: sizeVariants(["UK 8","UK 9","UK 10"], "3999") },
  { title: "Puma Tazon 7", tags: "training,gym,budget,men,cross-training", body_html: "Budget gym shoe. Lightweight and durable. Good for cardio and light training. Best under ₹2000.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "1999") },
  { title: "Nike Wildhorse 7", tags: "running,trail,men,women,outdoor", body_html: "Trail running shoe. Aggressive outsole grip. Rock plate for protection. For off-road and trail runs.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "4999") },
  { title: "Salomon Speedcross 6", tags: "running,trail,men,women,outdoor,premium", body_html: "Best-in-class trail shoe. Deep lugs for muddy terrain. Protective toe cap. Serious trail runners.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "7499") },
  { title: "Woodland Casual Oxford", tags: "casual,outdoor,men,durable,everyday", body_html: "Durable Woodland casual. Leather upper, rubber sole. Good for outdoor casual wear and travel.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "2499") },
  { title: "Sparx Sports Running Shoe", tags: "running,budget,men,everyday", body_html: "Ultra-budget running shoe. Lightweight mesh upper. EVA sole. Best for beginners under ₹1000.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "899") },
  { title: "HRX by Hrithik Roshan Runner", tags: "running,budget,men,women,everyday", body_html: "Popular Indian budget runner. Mesh upper, cushioned sole. Good for daily casual running.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "1499") },
  { title: "Adidas Duramo SL", tags: "running,neutral,budget,men,women,everyday", body_html: "Everyday budget runner from Adidas. Cloudfoam midsole. Lightweight and comfortable. Great entry-level shoe.", variants: sizeVariants(["UK 6","UK 7","UK 8","UK 9"], "2499") },
  { title: "Nike Revolution 7", tags: "running,neutral,budget,men,women,everyday", body_html: "Nike's entry-level running shoe. Foam midsole, breathable mesh. Good for casual running and gym.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "2999") },
  { title: "ASICS Gel-Nimbus 25", tags: "running,neutral,premium,long-distance,cushioned", body_html: "ASICS flagship cushioned trainer. Maximum gel cushioning. Ideal for marathon training and long runs.", variants: sizeVariants(["UK 7","UK 8","UK 9"], "7499") },
  { title: "Fila Ranger Trail", tags: "casual,outdoor,men,budget,everyday", body_html: "Budget casual outdoor shoe. Chunky sole, good grip. Comfortable for daily wear and light outdoor use.", variants: sizeVariants(["UK 7","UK 8","UK 9","UK 10"], "1799") },
];

// ── Additional wellness products (new — not yet in Shopify) ─────
const wellnessProducts = [
  {
    title: "Lifelong Massage Gun LLM280",
    tags: "wellness,recovery,massage,muscle,men,women,premium",
    body_html: "Professional-grade percussion massage gun. 6 attachments, 20 speed settings. 2400 RPM. Reduces soreness post-workout. Rechargeable battery, 3hr use per charge.",
    options: [{ name: "Type" }],
    variants: [{ option1: "Standard", price: "3999" }]
  },
  {
    title: "Posture Corrector Back Support",
    tags: "wellness,posture,back,office,men,women,budget",
    body_html: "Adjustable posture corrector brace. Clavicle support, breathable mesh. Helps correct rounded shoulders and upper back pain from long desk hours.",
    options: [{ name: "Size" }],
    variants: [
      { option1: "S/M", price: "799" },
      { option1: "L/XL", price: "799" }
    ]
  },
  {
    title: "Sleep Mask 3D Contoured Eye Mask",
    tags: "wellness,sleep,recovery,men,women,budget",
    body_html: "Contoured 3D sleep mask with zero eye pressure. Adjustable strap, memory foam. Blocks 100% light. Perfect for travel, naps, and better sleep quality.",
    options: [{ name: "Type" }],
    variants: [{ option1: "Standard", price: "399" }]
  },
  {
    title: "Compression Socks (3 Pair Pack)",
    tags: "wellness,recovery,compression,socks,running,travel,men,women,budget",
    body_html: "Graduated compression socks 20-30mmHg. Reduces swelling and fatigue. Great for running, long flights, standing jobs. 3 pairs per pack.",
    options: [{ name: "Size" }],
    variants: [
      { option1: "S/M (EU 35-40)", price: "599" },
      { option1: "L/XL (EU 41-46)", price: "599" }
    ]
  },
];

const allProducts = [...wellnessProducts]; // Only seed new products not already in Shopify

async function seedProducts() {
  console.log(`Seeding ${allProducts.length} products to ${SHOP}...`);
  let success = 0;
  for (const product of allProducts) {
    try {
      const options = product.options || [{ name: 'Size' }];
      const { options: _opts, ...rest } = product;
      const response = await axios.post(
        `https://${SHOP}/admin/api/2024-01/products.json`,
        { product: { ...rest, status: 'active', published: true, options } },
        { headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' } }
      );
      console.log(`✅ Created: ${response.data.product.title} (${response.data.product.variants.length} variants)`);
      success++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`❌ Failed: ${product.title} — ${JSON.stringify(err.response?.data?.errors) || err.message}`);
    }
  }
  console.log(`\nDone! ${success}/${allProducts.length} products created.`);
}

seedProducts();
