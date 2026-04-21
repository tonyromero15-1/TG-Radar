// index.js - GitHub Actions version
// Uses ScraperAPI to bypass pump.fun IP blocking

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;

const PUMPFUN_URL = 'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false';

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
    if (!res.ok) console.error('Telegram error:', await res.text());
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function main() {
  console.log('🟢 TG Radar scanning pump.fun via ScraperAPI...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  if (!SCRAPER_KEY) {
    console.error('❌ Missing SCRAPER_API_KEY');
    process.exit(1);
  }

  try {
    const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(PUMPFUN_URL)}`;

    const res = await fetch(scraperUrl);

    if (!res.ok) {
      console.error('ScraperAPI error:', res.status, await res.text());
      process.exit(1);
    }

    const text = await res.text();

    let tokens;
    try {
      tokens = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse response:', text.slice(0, 300));
      process.exit(1);
    }

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
