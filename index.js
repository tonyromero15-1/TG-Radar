// index.js - GitHub Actions version
// Uses pumpportal.fun - free public API that mirrors pump.fun data
// No blocking, no proxies needed

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const API_URL = 'https://pumpportal.fun/api/data/tokens?limit=50&sort=created&order=desc';

function extractTelegram(token) {
  const fields = [
    token.telegram,
    token.twitter,
    token.website,
    token.description,
    token.metadata?.telegram,
    token.metadata?.twitter,
    token.metadata?.website,
    token.metadata?.description,
  ];
  for (const f of fields) {
    if (!f || typeof f !== 'string') continue;
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
  const mcap = formatMcap(token.usd_market_cap || token.market_cap);
  const ca = token.mint || token.address || 'N/A';
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
    if (!res.ok) console.error('Telegram error:', await res.text());
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function main() {
  console.log('🟢 TG Radar scanning via pumpportal.fun...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  try {
    const res = await fetch(API_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('API error:', res.status, text.slice(0, 200));
      process.exit(1);
    }

    const text = await res.text();
    console.log('Raw response preview:', text.slice(0, 200));

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse JSON:', text.slice(0, 300));
      process.exit(1);
    }

    const tokens = Array.isArray(data) ? data : (data.tokens || data.data || data.results || []);
    console.log(`Found ${tokens.length} tokens`);

    let alerted = 0;

    for (const token of tokens) {
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
