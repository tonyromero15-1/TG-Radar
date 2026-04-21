// index.js - GitHub Actions version
// Strategy: Fetch recently launched tokens, check IPFS metadata for socials
// Runs every 10 minutes via GitHub Actions cron
// Uses a cache file to avoid double-alerting the same token

import { readFileSync, writeFileSync, existsSync } from 'fs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CACHE_FILE = 'seen_tokens.json';

// Multiple IPFS gateways
const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

// Load seen tokens cache
function loadCache() {
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      // Only keep tokens from last 24 hours to prevent cache growing forever
      const oneDayAgo = Date.now() - 86400000;
      const filtered = {};
      for (const [mint, timestamp] of Object.entries(data)) {
        if (timestamp > oneDayAgo) filtered[mint] = timestamp;
      }
      return filtered;
    }
  } catch {}
  return {};
}

// Save seen tokens cache
function saveCache(cache) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error('Cache save error:', e.message);
  }
}

function getIPFSHash(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '');
  const match = uri.match(/\/ipfs\/(.+)/);
  return match ? match[1] : null;
}

async function fetchIPFSMetadata(uri) {
  const hash = getIPFSHash(uri);
  const urls = hash ? IPFS_GATEWAYS.map(g => g + hash) : [uri];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch {}
      }
    } catch {}
  }
  return null;
}

function extractSocials(metadata) {
  if (!metadata) return null;
  const str = JSON.stringify(metadata);

  const tgMatch = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@]+/);
  const twMatch = str.match(/https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/);

  // Website - exclude known non-project URLs
  const excluded = /twitter|x\.com|t\.me|ipfs|pump\.fun|cloudflare|pinata|solana/i;
  const webMatch = str.match(/https?:\/\/(?!.*(?:twitter|x\.com|t\.me|ipfs|pump\.fun|cloudflare|pinata|solana))[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"',]*/);

  const telegram = tgMatch ? tgMatch[0] : null;
  const twitter = twMatch ? twMatch[0] : null;
  const website = webMatch && !excluded.test(webMatch[0]) ? webMatch[0] : null;

  if (!telegram && !twitter && !website) return null;
  return { telegram, twitter, website };
}

function formatMcap(solAmount) {
  if (!solAmount) return 'Unknown';
  const usd = solAmount * 150;
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

async function sendTelegramAlert(token, socials) {
  const mcap = formatMcap(token.marketCapSol || token.usd_market_cap);
  const ca = token.mint || 'N/A';
  const name = token.name || 'Unknown';
  const ticker = token.symbol || '???';

  const lines = [
    `🟢 *NEW MEMECOIN WITH SOCIALS*`,
    ``,
    `*${name}* — $${ticker}`,
    `💰 Market Cap: ${mcap}`,
    `📋 CA: \`${ca}\``,
    ``,
  ];

  if (socials.telegram) lines.push(`📱 Telegram: ${socials.telegram}`);
  if (socials.twitter) lines.push(`🐦 Twitter: ${socials.twitter}`);
  if (socials.website) lines.push(`🌐 Website: ${socials.website}`);

  lines.push(``);
  lines.push(`🔗 Pump.fun: https://pump.fun/${ca}`);
  lines.push(`⏱ Recently launched`);

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
    else console.log(`✅ Alert: ${name} ($${ticker})`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function fetchRecentTokens() {
  // Fetch last 50 tokens from pumpportal REST endpoint
  const urls = [
    'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://frontend-api-v2.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        const tokens = Array.isArray(data) ? data : (data.coins || []);
        if (tokens.length > 0) {
          console.log(`Got ${tokens.length} tokens from ${url}`);
          return tokens;
        }
      }
    } catch (e) {
      console.log(`Failed ${url}: ${e.message}`);
    }
  }
  return [];
}

async function main() {
  console.log('🟢 TG Radar scanning recent tokens for socials...\n');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing env vars');
    process.exit(1);
  }

  const cache = loadCache();
  console.log(`Cache has ${Object.keys(cache).length} already-seen tokens\n`);

  const tokens = await fetchRecentTokens();

  if (tokens.length === 0) {
    console.log('No tokens fetched — API may be down');
    process.exit(0);
  }

  let checked = 0;
  let alerted = 0;
  let skipped = 0;

  for (const token of tokens) {
    if (!token.mint || !token.uri) continue;

    // Skip already alerted tokens
    if (cache[token.mint]) {
      skipped++;
      continue;
    }

    checked++;
    const metadata = await fetchIPFSMetadata(token.uri);
    const socials = extractSocials(metadata);

    if (socials) {
      await sendTelegramAlert(token, socials);
      cache[token.mint] = Date.now();
      alerted++;
      await new Promise(r => setTimeout(r, 500));
    } else {
      // Mark as seen even without socials so we don't keep checking
      cache[token.mint] = Date.now();
      console.log(`No socials: ${token.name || token.mint}`);
    }
  }

  saveCache(cache);
  console.log(`\n📊 Done. Checked ${checked} tokens, sent ${alerted} alerts, skipped ${skipped} cached`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
