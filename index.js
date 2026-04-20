// index.js - GitHub Actions version
// Uses Helius API (free) to fetch new pump.fun token metadata
// Helius never blocks and gives us direct on-chain data

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// pump.fun program ID on Solana
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function extractTelegram(text) {
  if (!text) return null;
  const match = text.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/);
  return match ? 'https://t.me/' + match[1] : null;
}

async function sendTelegramAlert(name, ticker, ca, tgLink, mcap) {
  const message = `🟢 *NEW MEMECOIN DETECTED*

*${name}* — $${ticker}
💰 Market Cap: ${mcap || 'Unknown'}
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
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
}

async function getRecentPumpTokens() {
  // Get recent transactions from pump.fun program
  const url = `https://api.helius.xyz/v0/addresses/${PUMP_FUN_PROGRAM}/transactions?api-key=${HELIUS_API_KEY}&limit=50&type=CREATE`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error('Helius transactions error:', res.status, await res.text());
    return [];
  }

  const txns = await res.json();
  if (!Array.isArray(txns)) return [];

  const mints = [];
  for (const tx of txns) {
    // Extract mint addresses from token transfers
    if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint) mints.push(transfer.mint);
      }
    }
  }

  return [...new Set(mints)]; // deduplicate
}

async function getTokenMetadata(mints) {
  if (mints.length === 0) return [];

  const url = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mintAccounts: mints.slice(0, 20) })
  });

  if (!res.ok) {
    console.error('Helius metadata error:', res.status);
    return [];
  }

  return await res.json();
}

async function main() {
  console.log('🟢 TG Radar scanning Solana via Helius...');

  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  if (!HELIUS_API_KEY) {
    console.error('❌ Missing HELIUS_API_KEY');
    process.exit(1);
  }

  try {
    const mints = await getRecentPumpTokens();
    console.log(`Found ${mints.length} recent pump.fun token mints`);

    if (mints.length === 0) {
      console.log('No new tokens found this run');
      return;
    }

    const metadataList = await getTokenMetadata(mints);
    console.log(`Got metadata for ${metadataList.length} tokens`);

    let alerted = 0;

    for (const meta of metadataList) {
      const name = meta.onChainMetadata?.metadata?.data?.name || 'Unknown';
      const ticker = meta.onChainMetadata?.metadata?.data?.symbol || '???';
      const ca = meta.account || 'N/A';

      // Check off-chain metadata (JSON URI) for Telegram
      let tgLink = null;

      const offChain = meta.offChainMetadata?.metadata;
      if (offChain) {
        // Check all string fields for t.me links
        const fields = [
          offChain.telegram,
          offChain.twitter,
          offChain.website,
          offChain.description,
          JSON.stringify(offChain.extensions || {})
        ];
        for (const f of fields) {
          tgLink = extractTelegram(f);
          if (tgLink) break;
        }
      }

      if (!tgLink) continue;

      await sendTelegramAlert(name, ticker, ca, tgLink, null);
      alerted++;

      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`✅ Scanned ${metadataList.length} tokens, sent ${alerted} alerts`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
