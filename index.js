require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const { createClient } = require('@supabase/supabase-js');

const { WHATSAPP_TOKEN, VERIFY_TOKEN, PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_KEY } = process.env;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Webhook Verification (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Incoming Messages (POST /webhook)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; 
      const profile = body.entry[0].changes[0].value.contacts[0].profile.name;
      const msgType = message.type;
      
      console.log(`Received ${msgType} from ${from} (${profile})`);

      await handleIncomingMessage(from, message, profile);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function handleIncomingMessage(from, message, profileName) {
  const type = message.type;
  
  try {
    // 1. Get or Register Seller
    let { data: seller, error: sErr } = await supabase.from('sellers').select('*').eq('phone_number', from).single();
    if (sErr && sErr.code === 'PGRST116') {
      const { data: newSeller } = await supabase.from('sellers').insert([{ phone_number: from, name: profileName }]).select().single();
      seller = newSeller;
    }

    if (type === 'image') {
      const mediaId = message.image.id;
      // 2. Identify Product by Image (In a real bot, we match mediaId or use AI)
      // For now, we search for a product that has this image_url (mediaId)
      let { data: product, error: pErr } = await supabase.from('products').select('*').eq('image_url', mediaId).single();
      
      if (pErr) {
        // Mock matching logic: If no image match, let's assume the first shoe for demo
        let { data: firstProd } = await supabase.from('products').select('*').limit(1).single();
        product = firstProd;
      }

      if (product) {
        // 3. Set Context: Save this as the "active" product for the seller
        await supabase.from('sellers').update({ last_product_sku: product.sku }).eq('phone_number', from);
        
        const text = `👟 *Product Identified: ${product.name}*\nStock: ${product.stock}\n\nSend *+* or *-* followed by a number to update (e.g. \`+10\` or \`-2\`)`;
        await sendWhatsAppMessage(from, text);
      } else {
        await sendWhatsAppMessage(from, "📸 I don't recognize this product image. Please send the SKU code or link this image to a product first.");
      }

    } else if (type === 'text') {
      const text = message.text.body.trim();
      
      // 1. Check for SEARCH command (e.g. "FIND shoes" or "S shoe")
      const searchRegex = /^(FIND|SEARCH|S)\s+(.+)$/i;
      const searchMatch = text.match(searchRegex);

      if (searchMatch) {
        const query = searchMatch[2];
        const { data: matches, error: sErr } = await supabase
          .from('products')
          .select('*')
          .ilike('name', `%${query}%`)
          .limit(5);

        if (sErr) throw sErr;

        if (matches.length === 0) {
          await sendWhatsAppMessage(from, `🔍 No products found matching "${query}". Try a different name!`);
        } else if (matches.length === 1) {
          const product = matches[0];
          await supabase.from('sellers').update({ last_product_sku: product.sku }).eq('phone_number', from);
          
          const reply = `🎯 *Found:* ${product.name}\nSKU: ${product.sku}\nStock: ${product.stock}\n\nSend \`+5\` or \`-2\` to update!`;
          await sendWhatsAppMessage(from, reply);
        } else {
          let list = `🧐 *Which one do you mean?*\n\n`;
          matches.forEach(m => { list += `• *${m.name}* (SKU: ${m.sku})\n`; });
          list += `\nType \`+5 [SKU]\` to update one of them!`;
          await sendWhatsAppMessage(from, list);
        }
        return;
      }

      // 2. Check for Stock Update command (e.g. "+10" or "+5 SKU001")
      const updateRegex = /^([+-])(\d+)(\s+(.+))?$/i;
      const updateMatch = text.match(updateRegex);

      if (updateMatch) {
        const action = updateMatch[1];
        const amount = parseInt(updateMatch[2]);
        const finalAmount = action === '+' ? amount : -amount;
        let sku = updateMatch[4] ? updateMatch[4].toUpperCase() : seller.last_product_sku;

        if (!sku) {
          return await sendWhatsAppMessage(from, "⚠️ I don't know which product you're updating. Please send a photo first or search for it (e.g. `FIND shoes`)!");
        }

        // 3. Update Stock
        const { data: product, error: prodErr } = await supabase.from('products').select('*').eq('sku', sku).single();
        if (prodErr) throw new Error(`Product ${sku} not found!`);

        const newStock = product.stock + finalAmount;
        await supabase.from('products').update({ stock: newStock }).eq('sku', sku);
        await supabase.from('inventory_logs').insert([{ sku, change_amount: finalAmount }]);

        // 4. Update Context
        await supabase.from('sellers').update({ last_product_sku: sku }).eq('phone_number', from);

        const reply = `✅ *Stock Updated!*\nProduct: ${product.name}\nChange: ${action}${amount}\nNew Total: *${newStock}*`;
        await sendWhatsAppMessage(from, reply);
      } else {
        await sendWhatsAppMessage(from, "🤖 *Inventory Bot Commands*\n\n📸 *Send a Photo*: Identify product\n🔍 *FIND [name]*: Search product\n➕ *+5*: Add stock\n➖ *-2*: Remove stock");
      }
    }
  } catch (err) {
    console.error(err);
    await sendWhatsAppMessage(from, `❌ Error: ${err.message}`);
  }
}

async function sendWhatsAppMessage(to, text) {
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      }
    });
    console.log(`Message sent to ${to}`);
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
