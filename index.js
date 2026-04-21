// index.js - Debug version
// Logs full token data from pumpportal WebSocket so we can see all available fields

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;

function extractTelegram(token) {
  // Check all string fields recursively for t.me links
  const str = JSON.stringify(token);
  const match = str.match(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)/);
  return match ? match[0] : null;
}

function formatMcap(val) {
  if (!val) return 'Unknown';
  if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1000) return '$' + (val / 1000).toFixed(1) + 'K';
  return '$' + val.toFixed(0);
}

async function sendTelegramAlert(token, tgLink) {
  const mcap = formatMcap(token.usdMarketCap || token.usd_market_cap || token.marketCap);
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
    else console.log(`✅ Alert sent for ${name} ($${ticker}) → ${tgLink}`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function main() {
  console.log('🟢 TG Radar connecting to pumpportal WebSocket...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  return new Promise((resolve) => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let tokenCount = 0;
    let alertCount = 0;

    ws.on('open', () => {
      console.log('✅ Connected to pumpportal.fun');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      console.log('👂 Listening for new tokens for 60 seconds...');

      setTimeout(() => {
        ws.close();
        console.log(`\n📊 Done. Saw ${tokenCount} tokens, sent ${alertCount} alerts`);
        resolve();
      }, LISTEN_DURATION_MS);
    });

    ws.on('message', async (data) => {
      try {
        const token = JSON.parse(data.toString());
        if (!token.mint) return;

        tokenCount++;

        // Log FULL token data for first 3 tokens so we can see all fields
        if (tokenCount <= 3) {
          console.log(`\n=== FULL TOKEN DATA (${tokenCount}) ===`);
          console.log(JSON.stringify(token, null, 2));
          console.log('=== END ===\n');
        }

        const tgLink = extractTelegram(token);
        if (tgLink) {
          alertCount++;
          await sendTelegramAlert(token, tgLink);
        } else {
          console.log(`No TG: ${token.name || token.mint}`);
        }

      } catch (err) {
        console.error('Parse error:', err.message);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      resolve();
    });

    ws.on('close', () => {
      console.log('WebSocket closed');
      resolve();
    });
  });
}

main().then(() => process.exit(0));
