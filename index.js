// index.js - GitHub Actions version
// Alerts for new pump.fun tokens that have Twitter/X or website links

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

function getIPFSHash(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '');
  const match = uri.match(/\/ipfs\/(.+)/);
  return match ? match[1] : null;
}

async function fetchIPFSMetadata(uri) {
  const hash = getIPFSHash(uri);
  const urls = hash
    ? IPFS_GATEWAYS.map(g => g + hash)
    : [uri];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

function extractLinks(metadata) {
  if (!metadata) return {};

  const str = JSON.stringify(metadata);

  // Extract Twitter/X
  const twitterMatch = str.match(/https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/);
  const twitter = twitterMatch ? twitterMatch[0] : null;

  // Extract Telegram
  const tgMatch = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@]+/);
  const telegram = tgMatch ? tgMatch[0] : null;

  // Extract website (not twitter/x/t.me/ipfs/pump.fun)
  const websiteMatch = str.match(/https?:\/\/(?!twitter|x\.com|t\.me|ipfs|pump\.fun|cloudflare|gateway)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"']*/);
  const website = websiteMatch ? websiteMatch[0] : null;

  return { twitter, telegram, website };
}

function formatMcap(solAmount) {
  if (!solAmount) return 'Unknown';
  const usd = solAmount * 150;
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

async function sendTelegramAlert(token, links) {
  const mcap = formatMcap(token.marketCapSol);
  const ca = token.mint || 'N/A';
  const name = token.name || 'Unknown';
  const ticker = token.symbol || '???';

  const lines = [
    `🟢 *NEW MEMECOIN DETECTED*`,
    ``,
    `*${name}* — $${ticker}`,
    `💰 Market Cap: ${mcap}`,
    `📋 CA: \`${ca}\``,
    ``,
  ];

  if (links.telegram) lines.push(`📱 Telegram: ${links.telegram}`);
  if (links.twitter) lines.push(`🐦 Twitter: ${links.twitter}`);
  if (links.website) lines.push(`🌐 Website: ${links.website}`);

  lines.push(`🔗 Pump.fun: https://pump.fun/${ca}`);
  lines.push(`⏱ Just launched`);

  const message = lines.join('\n');
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
    else console.log(`✅ ALERT: ${name} ($${ticker})`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function processToken(token) {
  const name = token.name || '???';

  if (!token.uri) {
    console.log(`  ⚠ No URI: ${name}`);
    return;
  }

  const metadata = await fetchIPFSMetadata(token.uri);
  if (!metadata) {
    console.log(`  ⚠ IPFS failed: ${name}`);
    return;
  }

  const links = extractLinks(metadata);
  const hasAnyLink = links.telegram || links.twitter || links.website;

  if (!hasAnyLink) {
    console.log(`  ❌ No links: ${name}`);
    return;
  }

  console.log(`  🔗 ${name} → TG:${!!links.telegram} X:${!!links.twitter} WEB:${!!links.website}`);
  await sendTelegramAlert(token, links);
}

async function main() {
  console.log('🟢 TG Radar starting...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing env vars');
    process.exit(1);
  }

  return new Promise((resolve) => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let tokenCount = 0;
    const processingQueue = [];

    ws.on('open', () => {
      console.log('✅ Connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      console.log('👂 Listening for 60 seconds...\n');

      setTimeout(async () => {
        ws.close();
        console.log(`\nProcessing ${tokenCount} tokens...`);
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
        console.log(`[${tokenCount}] ${token.name || '???'}`);
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
