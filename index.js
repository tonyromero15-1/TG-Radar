// index.js - GitHub Actions version
// Sources: pumpportal (pump.fun Solana) + DexScreener (all chains)
// Priority: Telegram > Website > Twitter/X account
// Filter: under $50K mcap, Telegram required

import { WebSocket } from 'ws';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LISTEN_DURATION_MS = 60000;
const MAX_MCAP_USD = 50000;

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

const alertedTokens = new Set();

// ─── IPFS ────────────────────────────────────────────────────────────────────

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
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (res.ok) {
        try { return await res.json(); } catch {}
      }
    } catch {}
  }
  return null;
}

// ─── SOCIAL EXTRACTION ───────────────────────────────────────────────────────

function isValidTwitterAccount(url) {
  if (!url) return false;
  // Must be twitter.com/x.com + username
  // Exclude communities, search, hashtags, status pages
  const invalid = /\/(communities|search|hashtag|status|explore|home|notifications|messages|i\/)/i;
  const match = url.match(/https?:\/\/(twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
  if (!match) return false;
  if (invalid.test(url)) return false;
  const username = match[2];
  // Skip reserved Twitter paths
  const reserved = ['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'login', 'i'];
  if (reserved.includes(username.toLowerCase())) return false;
  return true;
}

function extractSocials(data) {
  if (!data) return null;
  const str = JSON.stringify(data);

  // Telegram - required
  const tgMatch = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@+]+/);
  const telegram = tgMatch ? tgMatch[0] : null;

  if (!telegram) return null; // Telegram is mandatory

  // Twitter/X - must be a real account
  const twMatches = str.match(/https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_/]+/g) || [];
  const twitter = twMatches.find(u => isValidTwitterAccount(u)) || null;

  // Website - exclude known non-project domains
  const excluded = /twitter|x\.com|t\.me|ipfs|pump\.fun|dexscreener|cloudflare|pinata|solana|arweave|birdeye|jupiter|raydium|meteora|discord\.gg/i;
  const webMatches = str.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"',]*/g) || [];
  const website = webMatches.find(u => !excluded.test(u)) || null;

  return { telegram, twitter, website };
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

function formatMcap(usd) {
  if (!usd || usd === 0) return 'Unknown';
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

function chainEmoji(chain) {
  const map = {
    solana: '🟣', ethereum: '🔵', bsc: '🟡', base: '🔷',
    arbitrum: '🔶', polygon: '🟪', avalanche: '🔴', tron: '🔴'
  };
  return map[chain?.toLowerCase()] || '⚪';
}

// ─── TELEGRAM ALERT ──────────────────────────────────────────────────────────

async function sendAlert({ name, ticker, ca, mcapUsd, socials, source, link, chain }) {
  const emoji = chainEmoji(chain);
  const sourceTag = source === 'pumpfun' ? 'Pump.fun' : `DexScreener (${chain?.toUpperCase() || 'unknown'})`;
  const hasFull = socials.telegram && socials.twitter && socials.website;
  const quality = hasFull ? '🔥' : socials.website ? '⭐' : '✅';

  const lines = [
    `${quality} *EARLY TOKEN ALERT*`,
    `${emoji} ${sourceTag}`,
    ``,
    `*${name}* — $${ticker}`,
    `💰 MCap: ${formatMcap(mcapUsd)}`,
    `📋 CA: \`${ca}\``,
    ``,
    `📱 Telegram: ${socials.telegram}`,
  ];

  if (socials.website) lines.push(`🌐 Website: ${socials.website}`);
  if (socials.twitter) lines.push(`🐦 Twitter: ${socials.twitter}`);

  lines.push(``);
  lines.push(`🔗 ${link}`);

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
    if (!res.ok) console.error('Telegram send error:', await res.text());
    else console.log(`✅ Alert: ${name} ($${ticker}) [${sourceTag}] MCap: ${formatMcap(mcapUsd)}`);
  } catch (err) {
    console.error('Failed to send alert:', err.message);
  }
}

// ─── PUMP.FUN SCANNER ────────────────────────────────────────────────────────

async function processPumpToken(token) {
  const name = token.name || '???';
  const ca = token.mint;
  if (!ca || alertedTokens.has(ca)) return;

  const mcapUsd = (token.marketCapSol || 0) * 150;
  if (mcapUsd > MAX_MCAP_USD && mcapUsd !== 0) return;

  if (!token.uri) return;

  const metadata = await fetchIPFSMetadata(token.uri);
  const socials = extractSocials(metadata);
  if (!socials) {
    console.log(`  No TG: ${name}`);
    return;
  }

  alertedTokens.add(ca);
  await sendAlert({
    name,
    ticker: token.symbol || '???',
    ca,
    mcapUsd,
    socials,
    source: 'pumpfun',
    link: `https://pump.fun/${ca}`,
    chain: 'solana'
  });
}

async function scanPumpFun() {
  return new Promise((resolve) => {
    console.log('📡 Connecting to pump.fun WebSocket...');
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let count = 0;
    const queue = [];

    ws.on('open', () => {
      console.log('✅ pump.fun connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      setTimeout(async () => {
        ws.close();
        await Promise.allSettled(queue);
        console.log(`pump.fun: processed ${count} tokens`);
        resolve();
      }, LISTEN_DURATION_MS);
    });

    ws.on('message', (data) => {
      try {
        const token = JSON.parse(data.toString());
        if (!token.mint) return;
        count++;
        console.log(`[pump] ${token.name || '???'}`);
        queue.push(processPumpToken(token));
      } catch {}
    });

    ws.on('error', (err) => { console.error('pump.fun error:', err.message); resolve(); });
    ws.on('close', () => resolve());
  });
}

// ─── DEXSCREENER SCANNER (ALL CHAINS) ────────────────────────────────────────

async function scanDexScreener() {
  console.log('\n📡 Scanning DexScreener (all chains)...');

  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) { console.log('DexScreener error:', res.status); return; }

    const tokens = await res.json();
    if (!Array.isArray(tokens)) { console.log('DexScreener bad format'); return; }

    console.log(`DexScreener: ${tokens.length} profiles across all chains`);

    for (const token of tokens) {
      const ca = token.tokenAddress;
      const chain = token.chainId;
      if (!ca || !chain || alertedTokens.has(`${chain}:${ca}`)) continue;

      // Extract socials from links array
      const links = token.links || [];
      let telegram = null, twitter = null, website = null;

      for (const link of links) {
        const u = link.url || '';
        if (u.includes('t.me') && !telegram) telegram = u;
        else if ((u.includes('twitter.com') || u.includes('x.com')) && isValidTwitterAccount(u) && !twitter) twitter = u;
        else if (link.type === 'website' && !website) website = u;
      }

      // Also scan description for t.me links
      if (!telegram && token.description) {
        const m = token.description.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@+]+/);
        if (m) telegram = m[0];
      }

      // Telegram required
      if (!telegram) continue;

      // Get pair data for mcap
      let mcapUsd = 0;
      try {
        const pairRes = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (pairRes.ok) {
          const pairData = await pairRes.json();
          const pairs = pairData.pairs || [];
          // Get the pair with highest liquidity
          const bestPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
          mcapUsd = bestPair?.marketCap || bestPair?.fdv || 0;
        }
      } catch {}

      // Apply mcap filter only if we got a valid mcap
      if (mcapUsd > MAX_MCAP_USD && mcapUsd !== 0) {
        console.log(`  Skip high mcap: ${ca.slice(0,8)} (${formatMcap(mcapUsd)})`);
        continue;
      }

      alertedTokens.add(`${chain}:${ca}`);

      const name = token.description?.split('\n')[0]?.slice(0, 40) || 'Unknown';
      console.log(`  🎯 dex match: ${name} [${chain}] MCap: ${formatMcap(mcapUsd)}`);

      await sendAlert({
        name,
        ticker: ca.slice(0, 6),
        ca,
        mcapUsd,
        socials: { telegram, twitter, website },
        source: 'dexscreener',
        link: `https://dexscreener.com/${chain}/${ca}`,
        chain
      });

      await new Promise(r => setTimeout(r, 400));
    }

  } catch (err) {
    console.error('DexScreener scan error:', err.message);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🟢 TG Radar — pump.fun + DexScreener (all chains)');
  console.log(`Filter: Telegram required | under $${MAX_MCAP_USD.toLocaleString()} mcap\n`);

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  await Promise.all([scanPumpFun(), scanDexScreener()]);

  console.log('\n📊 All done.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
