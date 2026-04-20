// index.js - Render Background Worker
// Runs continuously, polls pump.fun every 30 seconds
// Sends Telegram alerts for new tokens with TG links

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUMPFUN_API = 'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false';
const INTERVAL_MS = 30000; // 30 seconds

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

  try {
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

    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram error:', err);
    }
  } catch (err) {
    console.error('Failed to send alert:', err.message);
  }
}

async function pollAndAlert() {
  try {
    const res = await fetch(PUMPFUN_API, {
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      console.error('Pump.fun API error:', res.status);
      return;
    }

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

      // Avoid Telegram rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[${new Date().toISOString()}] Scanned ${tokens.length} tokens, alerted ${alerted} new TG links`);

  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

async function main() {
  console.log('🟢 TG Radar started — polling pump.fun every 30 seconds');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables');
    process.exit(1);
  }

  // Run immediately on start
  await pollAndAlert();

  // Then loop every 30 seconds
  setInterval(pollAndAlert, INTERVAL_MS);
}

main();
