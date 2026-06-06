import QRCode from 'qrcode';
import { config } from './config.js';
import { deriveAddress } from './hdwallet.js';

export const COINS = {
  btc: { scheme: 'bitcoin', label: 'Bitcoin', ticker: 'BTC', decimals: 8 },
  ltc: { scheme: 'litecoin', label: 'Litecoin', ticker: 'LTC', decimals: 8 },
};

function xpubFor(coin) {
  return coin === 'btc' ? config.crypto.btcXpub : coin === 'ltc' ? config.crypto.ltcXpub : '';
}
function staticAddr(coin) {
  return coin === 'btc' ? config.crypto.btcAddress : coin === 'ltc' ? config.crypto.ltcAddress : '';
}

export function hasXpub(coin) {
  return Boolean(xpubFor(coin));
}
export function isCoinAvailable(coin) {
  return Boolean(xpubFor(coin) || staticAddr(coin));
}

// Receive address for a payment: a unique derived address when an xpub is set
// (enables the watcher), otherwise the static fallback address.
export function receiveAddress(coin, index) {
  const xpub = xpubFor(coin);
  if (xpub) return deriveAddress(coin, xpub, index);
  return staticAddr(coin);
}

// ── HTTP with timeout (price feed + explorers) ───────────────────────
// A hung upstream must never block the payment watcher tick, so every
// external call is bounded by AbortSignal.timeout.
async function fetchJson(url, { timeoutMs = config.crypto.httpTimeoutMs } = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── USD → crypto pricing (60s cache, CoinGecko → Coinbase fallback) ──
let _cache = { at: 0, prices: null };
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin&vs_currencies=usd';
const coinbaseUrl = (pair) => `https://api.coinbase.com/v2/prices/${pair}/spot`;

async function fetchCoingecko() {
  const j = await fetchJson(COINGECKO_URL);
  const prices = { btc: j.bitcoin?.usd, ltc: j.litecoin?.usd };
  if (!prices.btc || !prices.ltc) throw new Error('coingecko missing fields');
  return prices;
}

async function fetchCoinbase() {
  const [btc, ltc] = await Promise.all([
    fetchJson(coinbaseUrl('BTC-USD')),
    fetchJson(coinbaseUrl('LTC-USD')),
  ]);
  const prices = {
    btc: Number.parseFloat(btc.data?.amount),
    ltc: Number.parseFloat(ltc.data?.amount),
  };
  if (!prices.btc || !prices.ltc) throw new Error('coinbase missing fields');
  return prices;
}

async function getPrices() {
  const now = Date.now();
  if (_cache.prices && now - _cache.at < 60_000) return _cache.prices;
  let prices;
  try {
    prices = await fetchCoingecko();
  } catch (err) {
    console.error('price feed: coingecko failed, falling back to coinbase:', err.message);
    prices = await fetchCoinbase(); // throws if the fallback also fails
  }
  _cache = { at: now, prices };
  return prices;
}

export async function priceUsd(coin) {
  const prices = await getPrices();
  return prices[coin];
}

export async function quote(coin, usdCents) {
  const rate = await priceUsd(coin);
  return (usdCents / 100 / rate).toFixed(COINS[coin].decimals);
}

// Quote plus the locked USD rate used, so it can be persisted with the order.
export async function quoteWithRate(coin, usdCents) {
  const rate = await priceUsd(coin);
  const amount = (usdCents / 100 / rate).toFixed(COINS[coin].decimals);
  return { amount, rate };
}

// USD-cent value of a crypto amount at the current rate (used to credit deposits).
export async function valueUsdCents(coin, cryptoAmountStr) {
  const rate = await priceUsd(coin);
  return Math.round(Number.parseFloat(cryptoAmountStr) * rate * 100);
}

export function toSats(amountStr) {
  return Math.round(Number.parseFloat(amountStr) * 1e8);
}

// ── Payment URI + QR ─────────────────────────────────────────────────
export function paymentUri(coin, amount, address) {
  return `${COINS[coin].scheme}:${address}?amount=${amount}`;
}
export function qrPng(coin, amount, address) {
  return QRCode.toBuffer(paymentUri(coin, amount, address), { width: 320, margin: 1 });
}

// ── Block explorers (mempool.space-style) ────────────────────────────
const EXPLORER_WEB = {
  btc: 'https://mempool.space/address/',
  ltc: 'https://litecoinspace.org/address/',
};
const EXPLORER_API = {
  btc: 'https://mempool.space/api',
  ltc: 'https://litecoinspace.org/api',
};

export function explorerUrl(coin, address) {
  const base = EXPLORER_WEB[coin];
  return base && address ? base + address : null;
}

// Total confirmed sats/litoshis received by an address. Used by the watcher.
export async function getConfirmedReceived(coin, address) {
  const base = EXPLORER_API[coin];
  if (!base) throw new Error(`no explorer for ${coin}`);
  const j = await fetchJson(`${base}/address/${address}`);
  return {
    confirmed: j.chain_stats?.funded_txo_sum ?? 0,
    mempool: j.mempool_stats?.funded_txo_sum ?? 0,
  };
}

// Most recent confirmed incoming tx to an address: { txid, blockHeight }, or
// null. Best-effort audit trail recorded at confirmation time (#8).
export async function getFundingTx(coin, address) {
  const base = EXPLORER_API[coin];
  if (!base) return null;
  try {
    const txs = await fetchJson(`${base}/address/${address}/txs`);
    if (!Array.isArray(txs)) return null;
    for (const tx of txs) {
      const pays = (tx.vout || []).some((o) => o.scriptpubkey_address === address);
      if (pays && tx.status?.confirmed) {
        return { txid: tx.txid, blockHeight: tx.status.block_height ?? null };
      }
    }
  } catch (err) {
    console.error(`getFundingTx ${coin} ${address}:`, err.message);
  }
  return null;
}
