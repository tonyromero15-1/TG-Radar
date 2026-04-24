// index.js - GitHub Actions version
// Aggressive pump.fun scanner
// - WebSocket for real-time new tokens
// - REST API polling for recent tokens (catches what WebSocket misses)
// - Under $20K mcap only
// - Alerts for Telegram, Twitter, OR website
// - Persistent cache to prevent duplicates

import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;
const MAX_MCAP_USD = 20000;
const CACHE_FILE = 'seen_tokens.json';

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
];

// ─── CACHE ───────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      const cutoff = Date.now() - 72 * 3600 * 1000; // 72hr window
      const clean = {};
      for (const [k, v] of Object.entries(data)) {
        if (v > cutoff) clean[k] = v;
      }
      return clean;
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
}

// ─── IPFS ────────────────────────────────────────────────────────────────────

function getIPFSHash(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '');
  const m = uri.match(/\/ipfs\/(.+)/);
  return m ? m[1] : null;
}

async function fetchIPFSMetadata(uri) {
  const hash = getIPFSHash(uri);
  const urls = hash ? IPFS_GATEWAYS.map(g => g + hash) : [uri];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) { try { return await res.json(); } catch {} }
    } catch {}
  }
  return null;
}

// ─── SOCIALS ─────────────────────────────────────────────────────────────────

function isValidTwitter(url) {
  if (!url) return false;
  const m = url.match(/https?:\/\/(twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
  if (!m) return false;
  const reserved = ['home', 'explore', 'notifications', 'messages', 'search',
    'settings', 'login', 'i', 'communities', 'hashtag', 'intent', 'share'];
  return !reserved.includes(m[2].toLowerCase());
}

function extractSocials(data) {
  if (!data) return null;
  const str = JSON.stringify(data);

  const tgMatch = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@+]+/);
  const telegram = tgMatch ? tgMatch[0] : null;

  const twMatches = str.match(/https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_/]+/g) || [];
  const twitter = twMatches.find(isValidTwitter) || null;

  const excluded = /twitter|x\.com|t\.me|ipfs|pump\.fun|dexscreener|cloudflare|pinata|solana|arweave|birdeye|jupiter|raydium|meteora|discord\.gg|google|apple|github|instagram|youtube|tiktok|reddit/i;
  const webMatches = str.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"',]*/g) || [];
  const website = webMatches.find(u => !excluded.test(u)) || null;

  // Need at least one social
  if (!telegram && !twitter && !website) return null;
  return { telegram, twitter, website };
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────

function formatMcap(usd) {
  if (!usd || usd === 0) return 'Unknown';
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

// ─── ALERT ───────────────────────────────────────────────────────────────────

async function sendAlert(token, socials, mcapUsd) {
  const name = token.name || 'Unknown';
  const ticker = token.symbol || '???';
  const ca = token.mint || 'N/A';

  const quality = socials.telegram && socials.twitter && socials.website ? '🔥'
    : socials.telegram && (socials.twitter || socials.website) ? '⭐'
    : socials.telegram ? '📱'
    : socials.twitter ? '🐦'
    : '🌐';

  const lines = [
    `${quality} *EARLY PUMP.FUN ALERT*`,
    ``,
    `*${name}* — $${ticker}`,
    `💰 MCap: ${formatMcap(mcapUsd)}`,
    `📋 CA: \`${ca}\``,
    ``,
  ];

  if (socials.telegram) lines.push(`📱 Telegram: ${socials.telegram}`);
  if (socials.website) lines.push(`🌐 Website: ${socials.website}`);
  if (socials.twitter) lines.push(`🐦 Twitter: ${socials.twitter}`);

  lines.push(``, `🔗 https://pump.fun/${ca}`);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: lines.join('\n'),
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) console.error('TG error:', await res.text());
    else console.log(`✅ ${name} ($${ticker}) MCap:${formatMcap(mcapUsd)} TG:${!!socials.telegram} X:${!!socials.twitter} WEB:${!!socials.website}`);
  } catch (err) {
    console.error('Send failed:', err.message);
  }
}

// ─── PROCESS TOKEN ───────────────────────────────────────────────────────────

async function processToken(token, cache) {
  const ca = token.mint;
  if (!ca || cache[ca]) return;

  const mcapUsd = (token.usd_market_cap || 0) || ((token.marketCapSol || 0) * 150);

  // Skip if mcap too high (allow unknown mcap through)
  if (mcapUsd > MAX_MCAP_USD && mcapUsd > 0) return;

  const uri = token.uri || token.image_uri;
  if (!uri) {
    // Mark as seen even without URI
    cache[ca] = Date.now();
    return;
  }

  const metadata = await fetchIPFSMetadata(uri);

  // Also check token fields directly (some tokens have socials in root)
  const combined = { ...token, ...(metadata || {}) };
  const socials = extractSocials(combined);

  // Mark as seen regardless
  cache[ca] = Date.now();

  if (!socials) {
    console.log(`  No socials: ${token.name || ca.slice(0, 8)}`);
    return;
  }

  await sendAlert(token, socials, mcapUsd);
  await new Promise(r => setTimeout(r, 400));
}

// ─── WEBSOCKET SCANNER ────────────────────────────────────────────────────────

async function scanWebSocket(cache) {
  return new Promise((resolve) => {
    console.log('📡 pump.fun WebSocket connecting...');
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let count = 0;
    const queue = [];

    ws.on('open', () => {
      console.log('✅ WebSocket connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      setTimeout(async () => {
        ws.close();
        await Promise.allSettled(queue);
        console.log(`WebSocket: ${count} tokens processed`);
        resolve();
      }, LISTEN_DURATION_MS);
    });

    ws.on('message', (data) => {
      try {
        const token = JSON.parse(data.toString());
        if (!token.mint) return;
        count++;
        console.log(`[ws] ${token.name || '???'} — MCap: ${formatMcap((token.marketCapSol || 0) * 150)}`);
        queue.push(processToken(token, cache));
      } catch {}
    });

    ws.on('error', (err) => { console.error('WS error:', err.message); resolve(); });
    ws.on('close', () => resolve());
  });
}

// ─── REST API SCANNER (catches tokens WebSocket might miss) ──────────────────

async function scanRestAPI(cache) {
  console.log('\n📡 Scanning pump.fun REST API (recent tokens)...');

  // Try multiple API versions and offsets for maximum coverage
  const requests = [
    'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://frontend-api-v3.pump.fun/coins?offset=50&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://frontend-api-v2.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
  ];

  for (const url of requests) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        console.log(`  API ${res.status}: ${url.split('?')[0]}`);
        continue;
      }

      const data = await res.json();
      const tokens = Array.isArray(data) ? data : (data.coins || []);

      if (tokens.length === 0) continue;

      console.log(`  Got ${tokens.length} tokens from REST`);

      const queue = tokens.map(t => processToken(t, cache));
      await Promise.allSettled(queue);
      break; // If one works, we're good

    } catch (e) {
      console.log(`  REST failed: ${e.message}`);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🟢 TG Radar — Aggressive pump.fun Scanner');
  console.log(`Filter: Any social link | Max mcap $${MAX_MCAP_USD.toLocaleString()}\n`);

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing env vars');
    process.exit(1);
  }

  const cache = loadCache();
  console.log(`Cache: ${Object.keys(cache).length} tokens already seen\n`);

  // Run WebSocket and REST simultaneously
  await Promise.all([
    scanWebSocket(cache),
    scanRestAPI(cache)
  ]);

  saveCache(cache);
  console.log('\n📊 All done.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
