// index.js - GitHub Actions version
// Connects to pumpportal WebSocket, fetches IPFS metadata, sends TG alerts

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;

// Multiple IPFS gateways to try in order
const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

function extractTelegram(obj) {
  if (!obj) return null;
  // Check direct fields first
  if (obj.telegram && typeof obj.telegram === 'string' && obj.telegram.includes('t.me')) {
    return obj.telegram.startsWith('http') ? obj.telegram : 'https://' + obj.telegram;
  }
  // Search entire JSON string for any t.me link
  const str = JSON.stringify(obj);
  const match = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@]+/);
  return match ? match[0] : null;
}

function formatMcap(solAmount) {
  if (!solAmount) return 'Unknown';
  const usd = solAmount * 150;
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

function getIPFSHash(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '');
  const match = uri.match(/\/ipfs\/(.+)/);
  return match ? match[1] : null;
}

async function fetchIPFSMetadata(uri) {
  const hash = getIPFSHash(uri);
  if (!hash) {
    // Try direct URL fetch
    try {
      const res = await fetch(uri, { signal: AbortSignal.timeout(6000) });
      if (res.ok) return await res.json();
    } catch {}
    return null;
  }

  // Try each gateway
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = gateway + hash;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch {}
  }
  return null;
}

async function sendTelegramAlert(token, tgLink, metadata) {
  const mcap = formatMcap(token.marketCapSol);
  const ca = token.mint || 'N/A';
  const name = token.name || metadata?.name || 'Unknown';
  const ticker = token.symbol || metadata?.symbol || '???';

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
    else console.log(`✅ ALERT SENT: ${name} ($${ticker}) → ${tgLink}`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function processToken(token) {
  const name = token.name || token.mint?.slice(0, 8);

  if (!token.uri) {
    console.log(`  ⚠ No URI: ${name}`);
    return;
  }

  const metadata = await fetchIPFSMetadata(token.uri);

  if (!metadata) {
    console.log(`  ⚠ IPFS failed: ${name}`);
    return;
  }

  console.log(`  📄 Metadata fields: ${Object.keys(metadata).join(', ')}`);

  const tgLink = extractTelegram(metadata);
  if (!tgLink) {
    console.log(`  ❌ No TG: ${name}`);
    return;
  }

  console.log(`  🔗 Found TG: ${tgLink}`);
  await sendTelegramAlert(token, tgLink, metadata);
}

async function main() {
  console.log('🟢 TG Radar starting...');

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
      console.log('👂 Listening for 60 seconds...\n');

      setTimeout(async () => {
        ws.close();
        console.log(`\nProcessing ${tokenCount} tokens...`);
        await Promise.allSettled(processingQueue);
        console.log('\n📊 Done.');
        resolve();
      }, LISTEN_DURATION_MS);
    });

    ws.on('message', (data) => {
      try {
        const token = JSON.parse(data.toString());
        if (!token.mint) return;
        tokenCount++;
        console.log(`\n[${tokenCount}] ${token.name || '???'} (${token.symbol || '???'})`);
        console.log(`  URI: ${token.uri?.slice(0, 60)}...`);
        processingQueue.push(processToken(token));
      } catch (err) {
        console.error('Parse error:', err.message);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      resolve();
    });

    ws.on('close', () => console.log('WebSocket closed'));
  });
}

main().then(() => process.exit(0));
