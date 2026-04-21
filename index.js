// index.js - GitHub Actions version
// Connects to pumpportal.fun WebSocket, collects new tokens for 60 seconds
// Sends Telegram alerts for any token that has a Telegram link

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000; // Listen for 60 seconds then exit

function extractTelegram(token) {
  const fields = [
    token.telegram,
    token.twitter,
    token.website,
    token.description,
    token.metadata?.telegram,
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
  const mcap = formatMcap(token.usdMarketCap || token.usd_market_cap);
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
    else console.log(`✅ Alert sent for ${name} ($${ticker})`);
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
    const queue = [];
    let processing = false;

    async function processQueue() {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const { token, tgLink } = queue.shift();
        await sendTelegramAlert(token, tgLink);
        await new Promise(r => setTimeout(r, 300));
      }
      processing = false;
    }

    ws.on('open', () => {
      console.log('✅ Connected to pumpportal.fun');
      // Subscribe to new token creations
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      console.log('👂 Listening for new tokens for 60 seconds...');

      // Close after 60 seconds
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
        const tgLink = extractTelegram(token);

        if (tgLink) {
          alertCount++;
          queue.push({ token, tgLink });
          processQueue();
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
