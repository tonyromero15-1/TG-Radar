// index.js - GitHub Actions version
// Sources: pumpportal WebSocket (pump.fun) + DexScreener new pairs API
// Filter: under $50K mcap, must have Telegram or Twitter
// Priority: Telegram > Twitter > Website

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

const alertedMints = new Set();

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

function extractSocials(data) {
  if (!data) return null;
  const str = JSON.stringify(data);

  const tgMatch = str.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@+]+/);
  const twMatch = str.match(/https?:\/\/(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/);
  const webMatch = str.match(/https?:\/\/(?!.*(?:twitter|x\.com|t\.me|ipfs|pump\.fun|dexscreener|cloudflare|pinata|solana|arweave|birdeye|jupiter))[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"',]*/);

  const telegram = tgMatch ? tgMatch[0] : null;
  const twitter = twMatch ? twMatch[0] : null;
  const website = webMatch ? webMatch[0] : null;

  // Must have at least Telegram or Twitter
  if (!telegram && !twitter) return null;

  return { telegram, twitter, website };
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

function formatMcap(usd) {
  if (!usd) return 'Unknown';
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

// ─── TELEGRAM ALERT ──────────────────────────────────────────────────────────

async function sendAlert(name, ticker, ca, mcapUsd, socials, source, pumpLink) {
  const quality = socials.telegram && socials.twitter ? '🔥' : socials.telegram ? '📱' : '🐦';
  const sourceTag = source === 'pumpfun' ? 'pump.fun' : 'DexScreener';

  const lines = [
    `${quality} *EARLY TOKEN ALERT*`,
    `📡 Source: ${sourceTag}`,
    ``,
    `*${name}* — $${ticker}`,
    `💰 MCap: ${formatMcap(mcapUsd)}`,
    `📋 CA: \`${ca}\``,
    ``,
  ];

  if (socials.telegram) lines.push(`📱 Telegram: ${socials.telegram}`);
  if (socials.twitter) lines.push(`🐦 Twitter: ${socials.twitter}`);
  if (socials.website) lines.push(`🌐 Website: ${socials.website}`);

  lines.push(``);
  lines.push(`🔗 ${pumpLink}`);

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
    else console.log(`✅ Alert: ${name} ($${ticker}) [${sourceTag}]`);
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

// ─── PUMP.FUN (WebSocket) ─────────────────────────────────────────────────────

async function processPumpToken(token) {
  const name = token.name || '???';
  const ca = token.mint;

  if (!ca || alertedMints.has(ca)) return;

  // Mcap filter
  const mcapUsd = (token.marketCapSol || 0) * 150;
  if (mcapUsd > MAX_MCAP_USD && mcapUsd !== 0) {
    console.log(`  Skip high mcap: ${name} (${formatMcap(mcapUsd)})`);
    return;
  }

  if (!token.uri) return;

  const metadata = await fetchIPFSMetadata(token.uri);
  const socials = extractSocials(metadata);

  if (!socials) {
    console.log(`  No socials: ${name}`);
    return;
  }

  alertedMints.add(ca);
  console.log(`  🎯 pump.fun match: ${name} TG:${!!socials.telegram} X:${!!socials.twitter}`);
  await sendAlert(
    name,
    token.symbol || '???',
    ca,
    mcapUsd,
    socials,
    'pumpfun',
    `https://pump.fun/${ca}`
  );
}

async function scanPumpFun() {
  return new Promise((resolve) => {
    console.log('\n📡 Connecting to pump.fun WebSocket...');
    const ws = new WebSocket('wss://pumpportal.fun/api/data');
    let count = 0;
    const queue = [];

    ws.on('open', () => {
      console.log('✅ pump.fun connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      setTimeout(async () => {
        ws.close();
        await Promise.allSettled(queue);
        console.log(`pump.fun: saw ${count} tokens`);
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

    ws.on('error', (err) => {
      console.error('pump.fun WS error:', err.message);
      resolve();
    });

    ws.on('close', () => resolve());
  });
}

// ─── DEXSCREENER (new pairs) ──────────────────────────────────────────────────

async function scanDexScreener() {
  console.log('\n📡 Scanning DexScreener new pairs...');

  try {
    // DexScreener latest token profiles endpoint - returns tokens with socials
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      console.log('DexScreener error:', res.status);
      return;
    }

    const tokens = await res.json();
    if (!Array.isArray(tokens)) {
      console.log('DexScreener unexpected format');
      return;
    }

    console.log(`DexScreener: ${tokens.length} token profiles`);

    for (const token of tokens) {
      const ca = token.tokenAddress;
      if (!ca || alertedMints.has(ca)) continue;

      // Only Solana tokens
      if (token.chainId !== 'solana') continue;

      // Extract socials from DexScreener links array
      const links = token.links || [];
      let telegram = null;
      let twitter = null;
      let website = null;

      for (const link of links) {
        const url = link.url || '';
        if (url.includes('t.me')) telegram = url;
        else if (url.includes('twitter.com') || url.includes('x.com')) twitter = url;
        else if (link.type === 'website') website = url;
      }

      // Also check description for t.me links
      if (!telegram && token.description) {
        const tgMatch = token.description.match(/https?:\/\/t\.me\/[a-zA-Z0-9_@+]+/);
        if (tgMatch) telegram = tgMatch[0];
      }

      if (!telegram && !twitter) continue;

      // No mcap filter here since DexScreener profiles don't always have mcap
      alertedMints.add(ca);

      console.log(`  🎯 dex match: ${token.description?.slice(0, 30) || ca}`);

      await sendAlert(
        token.description?.split('\n')[0]?.slice(0, 30) || 'Unknown',
        ca.slice(0, 6),
        ca,
        null,
        { telegram, twitter, website },
        'dexscreener',
        `https://dexscreener.com/solana/${ca}`
      );

      await new Promise(r => setTimeout(r, 400));
    }

  } catch (err) {
    console.error('DexScreener error:', err.message);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🟢 TG Radar — scanning pump.fun + DexScreener');
  console.log(`Filter: under $${MAX_MCAP_USD.toLocaleString()} mcap | needs Telegram or Twitter\n`);

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  // Run both scanners simultaneously
  await Promise.all([
    scanPumpFun(),
    scanDexScreener()
  ]);

  console.log('\n📊 All done.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
