// index.js - GitHub Actions version
// Gets new tokens from pumpportal WebSocket
// Fetches IPFS metadata URI to find Telegram links
// Sends alerts to Telegram group

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;

function extractTelegram(obj) {
  if (!obj) return null;
  const str = JSON.stringify(obj);
  const match = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_]+/);
  return match ? match[0] : null;
}

function formatMcap(solAmount) {
  if (!solAmount) return 'Unknown';
  // Rough USD estimate (SOL ~$150)
  const usd = solAmount * 150;
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

async function fetchIPFSMetadata(uri) {
  try {
    // Convert IPFS URI if needed
    const url = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function sendTelegramAlert(token, tgLink) {
  const mcap = formatMcap(token.marketCapSol);
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
    else console.log(`✅ Alert sent: ${name} ($${ticker}) → ${tgLink}`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function processToken(token) {
  const name = token.name || token.mint;

  if (!token.uri) {
    console.log(`No URI: ${name}`);
    return;
  }

  const metadata = await fetchIPFSMetadata(token.uri);
  if (!metadata) {
    console.log(`No metadata: ${name}`);
    return;
  }

  const tgLink = extractTelegram(metadata);
  if (!tgLink) {
    console.log(`No TG: ${name}`);
    return;
  }

  await sendTelegramAlert(token, tgLink);
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
      console.log('👂 Listening for 60 seconds...');

      setTimeout(async () => {
        ws.close();
        console.log(`Saw ${tokenCount} tokens, waiting for IPFS fetches...`);
        await Promise.allSettled(processingQueue);
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
        processingQueue.push(processToken(token));
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
