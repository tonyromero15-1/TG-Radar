// api/index.js
// Deploy this to Vercel as a serverless function
// It polls pump.fun for new tokens with Telegram links and alerts your group

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUMPFUN_API = 'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false';

// In-memory seen mints (resets on cold start — acceptable for serverless)
const seenMints = new Set();

function extractTelegram(token) {
  const fields = [token.telegram, token.website, token.description, token.twitter];
  for (const f of fields) {
    if (!f) continue;
    const match = f.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/);
    if (match) return 'https://t.me/' + match[1];
  }
  return null;
}

function formatMcap(val) {
  if (!val) return 'Unknown';
  if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1000) return '$' + (val / 1000).toFixed(1) + 'K';
  return '$' + val.toFixed(0);
}

function truncateCA(ca) {
  if (!ca) return 'N/A';
  return ca.slice(0, 6) + '...' + ca.slice(-6);
}

async function sendTelegramAlert(token, tgLink) {
  const mcap = formatMcap(token.usd_market_cap);
  const ca = token.mint || 'N/A';
  const name = token.name || 'Unknown';
  const ticker = token.symbol || '???';

  const message = `🟢 *NEW MEMECOIN DETECTED*

*${name}* — $${ticker}
💰 Market Cap: ${mcap}
📋 CA: \`${ca}\`

📱 *Telegram:* ${tgLink}
🔗 *Pump.fun:* https://pump.fun/${ca}

⏱ Just launched on pump.fun`;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });

  return res.ok;
}

async function pollAndAlert() {
  const res = await fetch(PUMPFUN_API, {
    headers: { 'Accept': 'application/json' }
  });

  if (!res.ok) throw new Error('Pump.fun API error: ' + res.status);

  const data = await res.json();
  const tokens = Array.isArray(data) ? data : (data.coins || []);

  let alerted = 0;

  for (const token of tokens) {
    if (!token.mint || seenMints.has(token.mint)) continue;
    seenMints.add(token.mint);

    const tgLink = extractTelegram(token);
    if (!tgLink) continue;

    await sendTelegramAlert(token, tgLink);
    alerted++;

    // Small delay between messages to avoid Telegram rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  return { scanned: tokens.length, alerted };
}

export default async function handler(req, res) {
  // Allow manual trigger via GET request
  // Vercel cron will call this endpoint on a schedule

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars' });
  }

  try {
    const result = await pollAndAlert();
    return res.status(200).json({
      ok: true,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
