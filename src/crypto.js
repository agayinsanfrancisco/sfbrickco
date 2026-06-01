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

// ── USD → crypto pricing (60s cache) ─────────────────────────────────
let _cache = { at: 0, prices: null };
const PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin&vs_currencies=usd';

async function getPrices() {
  const now = Date.now();
  if (_cache.prices && now - _cache.at < 60_000) return _cache.prices;
  const res = await fetch(PRICE_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`price feed ${res.status}`);
  const json = await res.json();
  const prices = { btc: json.bitcoin?.usd, ltc: json.litecoin?.usd };
  if (!prices.btc || !prices.ltc) throw new Error('price feed missing fields');
  _cache = { at: now, prices };
  return prices;
}

export async function quote(coin, usdCents) {
  const prices = await getPrices();
  const amount = usdCents / 100 / prices[coin];
  return amount.toFixed(COINS[coin].decimals);
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
  const res = await fetch(`${base}/address/${address}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const j = await res.json();
  return {
    confirmed: j.chain_stats?.funded_txo_sum ?? 0,
    mempool: j.mempool_stats?.funded_txo_sum ?? 0,
  };
}
