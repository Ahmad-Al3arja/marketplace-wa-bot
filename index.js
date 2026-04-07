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

      if (msgType === 'interactive') {
        await handleInteractiveReply(from, message.interactive);
      } else {
        await handleIncomingMessage(from, message, profile);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function handleInteractiveReply(from, interactive) {
  const buttonId = interactive.button_reply.id;
  let actionText = '';
  let pendingAction = '';

  if (buttonId === 'btn_add') {
    actionText = "How many items would you like to *Add*?";
    pendingAction = 'ADD';
  } else if (buttonId === 'btn_remove') {
    actionText = "How many items would you like to *Remove*?";
    pendingAction = 'REMOVE';
  } else if (buttonId.startsWith('select_')) {
    const sku = buttonId.replace('select_', '');
    const { data: product } = await supabase.from('products').select('name').eq('sku', sku).single();
    await supabase.from('sellers').update({ last_product_sku: sku, pending_action: null }).eq('phone_number', from);
    return await sendProductMenu(from, product.name, sku);
  }

  if (pendingAction) {
    await supabase.from('sellers').update({ pending_action: pendingAction }).eq('phone_number', from);
    await sendWhatsAppMessage(from, actionText);
  }
}

async function sendProductMenu(from, name, sku) {
  const buttons = [
    { id: 'btn_add', title: '➕ Add Stock' },
    { id: 'btn_remove', title: '➖ Remove Stock' }
  ];
  await sendWhatsAppInteractive(from, `📦 *Product:* ${name}\nSKU: ${sku}\n\nWhat would you like to do?`, buttons);
}

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
      const caption = message.image.caption ? message.image.caption.trim() : null;
      
      let product;
      let isNew = false;

      if (caption) {
        // 1. Try to find by name/caption first for this seller
        const { data: existing } = await supabase.from('products').select('*').eq('seller_phone', from).eq('name', caption).single();
        
        if (existing) {
          product = existing;
          await supabase.from('products').update({ image_url: mediaId }).eq('sku', product.sku);
        } else {
          // 2. Auto-Register: Create new product
          const newSku = `SKU-${caption.replace(/\s+/g, '-').toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
          const { data: created } = await supabase.from('products').insert([{ sku: newSku, name: caption, image_url: mediaId, seller_phone: from, stock: 0 }]).select().single();
          product = created;
          isNew = true;
        }
      } else {
        // 3. Simple Identification: Search for product with this image_url
        const { data: matched } = await supabase.from('products').select('*').eq('image_url', mediaId).single();
        product = matched;
      }

      if (product) {
        await supabase.from('sellers').update({ last_product_sku: product.sku, pending_action: null }).eq('phone_number', from);
        const statusText = isNew ? `✅ *Registered:* ${product.name}` : `👟 *Product Identified*`;
        await sendProductMenu(from, product.name, product.sku);
      } else {
        await sendWhatsAppMessage(from, "📸 Don't recognize this. Send again with a *Caption* (e.g., 'Blue Shoes') to register it!");
      }

    } else if (type === 'text') {
      const text = message.text.body.trim();
      
      // 1. Check for SEARCH command (Private search)
      const searchRegex = /^(FIND|SEARCH|S)\s+(.+)$/i;
      const searchMatch = text.match(searchRegex);

      if (searchMatch) {
        const query = searchMatch[2];
        const { data: matches } = await supabase.from('products').select('*').eq('seller_phone', from).ilike('name', `%${query}%`).limit(3);

        if (!matches || matches.length === 0) {
          await sendWhatsAppMessage(from, `🔍 No products found matching "${query}".`);
        } else if (matches.length === 1) {
          const product = matches[0];
          await supabase.from('sellers').update({ last_product_sku: product.sku, pending_action: null }).eq('phone_number', from);
          await sendProductMenu(from, product.name, product.sku);
        } else {
          const buttons = matches.map(m => ({ id: `select_${m.sku}`, title: m.name.substring(0, 20) }));
          await sendWhatsAppInteractive(from, `🧐 *Multiple found. Select one:*`, buttons);
        }
        return;
      }

      // 2. Check for Stock Update (+5, -2, or just a number if pending)
      const updateRegex = /^([+-])?(\d+)(\s+(.+))?$/i;
      const updateMatch = text.match(updateRegex);

      if (updateMatch) {
        const sign = updateMatch[1];
        const amount = parseInt(updateMatch[2]);
        const providedSku = updateMatch[4] ? updateMatch[4].toUpperCase() : null;
        
        let finalAmount;
        let sku = providedSku || seller.last_product_sku;

        if (sign) {
          finalAmount = sign === '+' ? amount : -amount;
        } else if (seller.pending_action) {
          finalAmount = seller.pending_action === 'ADD' ? amount : -amount;
        } else {
          return await sendWhatsAppMessage(from, "⚠️ Use `+` or `-` (e.g. `+5`) or tap a button first!");
        }

        if (!sku) return await sendWhatsAppMessage(from, "⚠️ Search for a product first!");

        // 3. Update DB
        const { data: product, error: pErr } = await supabase.from('products').select('*').eq('sku', sku).single();
        if (pErr) throw new Error(`Product ${sku} not found!`);

        const newStock = product.stock + finalAmount;
        await supabase.from('products').update({ stock: newStock }).eq('sku', sku);
        await supabase.from('sellers').update({ pending_action: null, last_product_sku: sku }).eq('phone_number', from);
        await supabase.from('inventory_logs').insert([{ sku, change_amount: finalAmount }]);

        await sendWhatsAppMessage(from, `✅ *Updated!* New total for *${product.name}* is *${newStock}*`);
      } else {
        await sendWhatsAppMessage(from, "🤖 *Commands:*\n📸 Send Photo (with caption to add)\n🔍 *FIND [item]*\n➕ *+5* or tap buttons");
      }
    }
  } catch (err) {
    console.error(err);
    await sendWhatsAppMessage(from, `❌ Error: ${err.message}`);
  }
}

async function sendWhatsAppInteractive(to, text, buttons) {
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title }
            }))
          }
        }
      }
    });
  } catch (error) {
    console.error('Error sending interactive:', error.response?.data || error.message);
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
