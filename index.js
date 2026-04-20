// index.js - GitHub Actions version
// Routes pump.fun request through proxy to bypass IP blocking

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PUMPFUN_URL = 'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false';
const PROXY_API = `https://api.allorigins.win/get?url=${encodeURIComponent(PUMPFUN_URL)}`;

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

async function main() {
  console.log('🟢 TG Radar scanning pump.fun via proxy...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  try {
    const res = await fetch(PROXY_API);

    if (!res.ok) {
      console.error('Proxy error:', res.status);
      process.exit(1);
    }

    const wrapper = await res.json();
    const tokens = JSON.parse(wrapper.contents);

    if (!Array.isArray(tokens)) {
      console.error('Unexpected format:', JSON.stringify(tokens).slice(0, 200));
      process.exit(1);
    }

    console.log(`Found ${tokens.length} tokens`);

    let alerted = 0;

    for (const token of tokens) {
      if (!token.mint) continue;

      const tgLink = extractTelegram(token);
      if (!tgLink) continue;

      await sendTelegramAlert(token, tgLink);
      alerted++;

      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`✅ Scanned ${tokens.length} tokens, sent ${alerted} alerts`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
