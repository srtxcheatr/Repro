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

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_my_balance',
      description: "Get the authenticated user's real current account balance in Rs. Always call this instead of guessing whenever the user asks about their balance, wallet, or how much credit/money they have.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_best_products',
      description: 'Get real products from the store catalog sorted by customer rating (best first), optionally filtered by a keyword. Always call this instead of guessing when the user asks for recommendations, "best" products, or what to buy.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Optional keyword to filter by product name/line, e.g. 'free fire' or 'pc'. Omit to search everything." },
          limit: { type: 'number', description: 'How many products to return. Default 5, max 10.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_leaderboard',
      description: 'Get the top spenders leaderboard (rank, display name, total spent). Use this when asked about rankings, the leaderboard, or who spends the most. Never contains email or phone numbers.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many ranks to return. Default 5, max 10.' },
        },
      },
    },
  },
];

const MAX_HISTORY_TURNS = 10;
const MAX_FUNCTION_ROUNDS = 3;

// Gemini's function-declaration shape derived from the one TOOLS list above,
// so there's only ever one place to add/edit a tool.
const GEMINI_TOOLS = [{
  functionDeclarations: TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: { type: 'OBJECT', properties: t.function.parameters.properties || {} },
  })),
}];

router.post('/chat', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 700) {
    return res.status(400).json({ success: false, error: 'Invalid message' });
  }

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY_TURNS) : [];
  const messages = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...rawHistory
      .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string' && h.text.trim())
      .map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text.slice(0, 2000) })),
    { role: 'user', content: message },
  ];

  // AI_PROVIDER picks which one goes first — 'gemini' (default) or 'groq'.
  // Whichever key(s) you actually have set decide what's usable; if the
  // primary provider fails (down, wrong region, bad key) and the OTHER
  // one has a key configured too, this falls back automatically. Adding
  // a third provider later means adding one more run*Chat() function and
  // one line here — never touching the route logic or the tools above.
  const primary = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const runners = primary === 'groq' ? [runGroqChat, runGeminiChat] : [runGeminiChat, runGroqChat];

  let lastError = null;
  for (const run of runners) {
    try {
      const result = await run(messages, req.uid);
      if (result === null) continue; // that provider's API key isn't set — skip, don't count as a failure
      return res.json({ success: true, ...result });
    } catch (e) {
      lastError = e;
      console.error(`[ai/chat] ${run.name} failed, trying next provider:`, e.message);
    }
  }

  const reason = lastError ? 'AI request failed' : 'AI is not configured — set GEMINI_API_KEY or GROQ_API_KEY';
  return res.status(lastError ? 502 : 500).json({ success: false, error: reason });
}));

// ---------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------
async function runGeminiChat(messages, uid) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const systemMsg = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  let card = null, cards = null, action = null;

  for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents,
        tools: GEMINI_TOOLS,
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '(no body)');
      throw new Error(`Gemini API returned ${r.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const functionCall = parts.find((p) => p.functionCall)?.functionCall;

    if (!functionCall) {
      const reply = parts.map((p) => p.text || '').join('').trim() || 'Sorry, I could not generate a response.';
      return { reply, card, cards, action };
    }

    contents.push({ role: 'model', parts: [{ functionCall }] });
    const result = await runTool({ name: functionCall.name, args: functionCall.args || {} }, uid);
    if (result.card) card = result.card;
    if (result.cards) cards = result.cards;
    if (result.action) action = result.action;
    contents.push({ role: 'function', parts: [{ functionResponse: { name: functionCall.name, response: result.data } }] });
  }
  throw new Error('AI took too many steps');
}

// ---------------------------------------------------------------
// Groq adapter (OpenAI-compatible chat completions)
// ---------------------------------------------------------------
async function runGroqChat(messages, uid) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const convo = [...messages];
  let card = null, cards = null, action = null;

  for (let round = 0; round < MAX_FUNCTION_ROUNDS; round++) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: convo, tools: TOOLS, tool_choice: 'auto', temperature: 0.4 }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '(no body)');
      throw new Error(`Groq API returned ${r.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await r.json();
    const responseMessage = data?.choices?.[0]?.message;
    const toolCalls = responseMessage?.tool_calls || [];

    if (!toolCalls.length) {
      const reply = (responseMessage?.content || '').trim() || 'Sorry, I could not generate a response.';
      return { reply, card, cards, action };
    }

    convo.push(responseMessage);
    for (const toolCall of toolCalls) {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { /* malformed args — treat as empty */ }
      const result = await runTool({ name: toolCall.function.name, args }, uid);
      if (result.card) card = result.card;
      if (result.cards) cards = result.cards;
      if (result.action) action = result.action;
      convo.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result.data) });
    }
  }
  throw new Error('AI took too many steps');
}

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
      if (p.maintenance || p.outOfStock) continue; // don't recommend something currently unbuyable
      if (query && !p.row.toLowerCase().includes(query) && !p.name.toLowerCase().includes(query)) continue;
      const key = p.row;
      if (!groups[key] || p.price < groups[key].price) {
        groups[key] = { name: p.row, rating: p.rating || null, reviewCount: p.reviewCount || 0, priceFrom: p.price };
      }
    }
    const products = Object.values(groups).sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, limit);

    return {
      data: { products },
      cards: products.map((p) => ({
        label: p.name,
        value: p.rating ? `⭐ ${p.rating}` : 'No reviews yet',
        note: `from Rs ${p.priceFrom}${p.reviewCount ? ` · ${p.reviewCount} review${p.reviewCount === 1 ? '' : 's'}` : ''}`,
      })),
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
