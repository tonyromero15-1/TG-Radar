// index.js - GitHub Actions version
// Step 1: Connect to pumpportal WebSocket to get new token mints
// Step 2: For each mint, fetch full token data from pump.fun API to get Telegram link
// Step 3: Alert group for any token with a Telegram link

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;

function extractTelegram(token) {
  const fields = [
    token.telegram,
    token.twitter,
    token.website,
    token.description,
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

async function fetchFullTokenData(mint) {
  try {
    const res = await fetch(`https://client-api-2-74b1891ee9f9.herokuapp.com/coins/${mint}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
    else console.log(`✅ Alert sent for ${name} ($${ticker}) → ${tgLink}`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function processToken(mint) {
  // Small delay to let pump.fun index the token
  await new Promise(r => setTimeout(r, 2000));

  const fullData = await fetchFullTokenData(mint);
  if (!fullData) {
    console.log(`  No data for ${mint}`);
    return;
  }

  const tgLink = extractTelegram(fullData);
  if (!tgLink) {
    console.log(`  No TG link for ${fullData.name || mint}`);
    return;
  }

  await sendTelegramAlert(fullData, tgLink);
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
    const processingQueue = [];

    ws.on('open', () => {
      console.log('✅ Connected to pumpportal.fun');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      console.log('👂 Listening for new tokens for 60 seconds...');

      setTimeout(async () => {
        ws.close();
        console.log(`\nSaw ${tokenCount} new tokens, processing for TG links...`);
        await Promise.all(processingQueue);
        console.log('📊 Done.');
        resolve();
      }, LISTEN_DURATION_MS);
    });

    ws.on('message', (data) => {
      try {
        const token = JSON.parse(data.toString());
        if (!token.mint) return;
        tokenCount++;
        console.log(`New token: ${token.name || token.mint}`);
        processingQueue.push(processToken(token.mint));
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
    });
  });
}

main().then(() => process.exit(0));
