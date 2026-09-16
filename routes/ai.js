import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getLiveCatalog } from '../src/catalog.js';

const router = express.Router();
router.use(userCors);
// AI calls cost real money/quota per request — its own tighter limit,
// separate from the generic API-wide one.
router.use(rateLimit({ windowMs: 60_000, max: 20, name: 'ai-chat' }));
router.use(requireFirebaseUid);

const SYSTEM_INSTRUCTION = `You are the SRT X CHEATS AI assistant, built into the store's website.
Help with: what products exist, recommending products (use get_best_products — never guess ratings or what's "best"), the user's own balance (use get_my_balance — never guess or estimate a number), and the spending leaderboard (use get_leaderboard).
Rules:
- Never invent account data (balance, purchase history, spending, rankings). If a tool result is missing something, say you can't verify it instead of guessing.
- Keep replies short and direct — a few sentences, not an essay. This is a small chat widget, not a document.
- If asked to do something unrelated to this store (brief chit-chat is fine, but not homework, unrelated coding help, etc), politely redirect back to what you can actually help with here.
- You cannot change anyone's balance, place orders, or modify accounts — you can only look things up and explain how to do things (e.g. "go to Store and tap Buy").
- Product downloads are all on the /allupdate.php page (WhatsApp channels per product line) — point people there for "how do I download/update" questions, don't guess a link.
- The leaderboard tool never gives you anyone's email or phone number — only a display name/rank/amount. If asked for another user's contact info, say you don't have access to that; only the site admin does.`;

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_my_balance',
      description: "Get the authenticated user's real current account balance in Rs. Always call this instead of guessing whenever the user asks about their balance, wallet, or how much credit/money they have.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'get_best_products',
      description: 'Get real products from the store catalog sorted by customer rating (best first), optionally filtered by a keyword. Always call this instead of guessing when the user asks for recommendations, "best" products, or what to buy.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: "Optional keyword to filter by product name/line, e.g. 'free fire' or 'pc'. Omit to search everything." },
          limit: { type: 'NUMBER', description: 'How many products to return. Default 5, max 10.' },
        },
      },
    },
    {
      name: 'get_leaderboard',
      description: 'Get the top spenders leaderboard (rank, display name, total spent). Use this when asked about rankings, the leaderboard, or who spends the most. Never contains email or phone numbers.',
      parameters: {
        type: 'OBJECT',
        properties: {
          limit: { type: 'NUMBER', description: 'How many ranks to return. Default 5, max 10.' },
        },
      },
    },
  ],
}];

const MAX_HISTORY_TURNS = 10;
const MAX_FUNCTION_ROUNDS = 3;

router.post('/chat', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 700) {
    return res.status(400).json({ success: false, error: 'Invalid message' });
  }

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY_TURNS) : [];
  const contents = rawHistory
    .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
    .map((h) => ({ role: h.role, parts: [{ text: h.text.slice(0, 2000) }] }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'AI is not configured' });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let card = null, cards = null, action = null;

  try {
    for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
      const gr = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents, tools: TOOLS, systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] } }),
      });
      if (!gr.ok) {
        const errBody = await gr.text().catch(() => '(no body)');
        console.error(`[ai/chat] Gemini API returned ${gr.status}:`, errBody.slice(0, 500));
        return res.status(502).json({ success: false, error: 'AI request failed' });
      }
      const gd = await gr.json();
      const parts = gd?.candidates?.[0]?.content?.parts || [];
      const functionCall = parts.find((p) => p.functionCall)?.functionCall;

      if (!functionCall) {
        const reply = parts.map((p) => p.text || '').join('').trim() || 'Sorry, I could not generate a response.';
        return res.json({ success: true, reply, card, cards, action });
      }

      contents.push({ role: 'model', parts: [{ functionCall }] });
      const result = await runTool(functionCall, req.uid);
      if (result.card) card = result.card;
      if (result.cards) cards = result.cards;
      if (result.action) action = result.action;
      contents.push({
        role: 'user',
        parts: [{ functionResponse: {
          name: functionCall.name,
          response: result.data,
          ...(functionCall.id ? { id: functionCall.id } : {}),
        } }],
      });
    }
    return res.status(502).json({ success: false, error: 'AI took too many steps — try rephrasing' });
  } catch (e) {
    console.error('[ai/chat] request threw:', e);
    return res.status(502).json({ success: false, error: 'AI request failed' });
  }
}));

async function runTool(functionCall, uid) {
  if (functionCall.name === 'get_my_balance') {
    const snap = await db().collection('users').doc(uid).get();
    const balance = snap.exists ? Number(snap.data().balance || 0) : 0;
    return {
      data: { balance },
      card: { label: 'Your Balance', value: `Rs ${balance}`, note: 'Live from your account right now' },
    };
  }

  if (functionCall.name === 'get_best_products') {
    const catalog = await getLiveCatalog('user');
    const query = String(functionCall.args?.query || '').toLowerCase().trim();
    const limit = Math.min(10, Math.max(1, Number(functionCall.args?.limit) || 5));

    // Group by product row (name) — a product usually has several
    // duration variants at different prices, all sharing one rating;
    // show the cheapest variant as "from Rs X".
    const groups = {};
    for (const p of Object.values(catalog)) {
      if (p.maintenance) continue; // don't recommend something currently unbuyable
      if (query && !p.row.toLowerCase().includes(query) && !p.name.toLowerCase().includes(query)) continue;
      const key = p.row;
      if (!groups[key] || p.price < groups[key].price) {
        groups[key] = { name: p.row, rating: p.rating || null, priceFrom: p.price };
      }
    }
    const products = Object.values(groups).sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, limit);

    return {
      data: { products },
      cards: products.map((p) => ({ label: p.name, value: p.rating ? `⭐ ${p.rating}` : 'New', note: `from Rs ${p.priceFrom}` })),
      action: products[0] ? { label: 'Open in Store', path: `/store.php?q=${encodeURIComponent(products[0].name)}` } : null,
    };
  }

  if (functionCall.name === 'get_leaderboard') {
    const limit = Math.min(10, Math.max(1, Number(functionCall.args?.limit) || 5));
    const snap = await db().collection('users').orderBy('totalSpent', 'desc').limit(limit).get();
    const rows = snap.docs.map((d, i) => {
      const data = d.data();
      // Privacy: this is reachable by any logged-in customer asking the
      // bot, not just the admin — never include another user's email or
      // phone/WhatsApp here. Only rank + a display name + amount. Full
      // contact details stay admin-only (GET /api/admin/rankings).
      const label = (data.profileName && data.profileName.trim()) || `Player-${d.id.slice(0, 5)}`;
      return { rank: i + 1, label, totalSpent: Number(data.totalSpent || 0), isYou: d.id === uid };
    });
    return {
      data: { leaderboard: rows },
      cards: rows.map((r) => ({ label: `#${r.rank} ${r.label}${r.isYou ? ' (you)' : ''}`, value: `Rs ${r.totalSpent}`, note: 'Total spent' })),
    };
  }

  return { data: { error: `Unknown tool: ${functionCall.name}` } };
}

export default router;
