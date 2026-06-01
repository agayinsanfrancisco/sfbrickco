import QRCode from 'qrcode';
import { config } from './config.js';

// Static-address crypto acceptance. Because all customers pay the same wallet,
// payments can't be auto-attributed to an order on-chain — confirmation is done
// by an admin (see flows/payments.js). This module handles pricing + QR only.

export const COINS = {
  btc: { id: 'bitcoin', scheme: 'bitcoin', label: 'Bitcoin', ticker: 'BTC', decimals: 8 },
  ltc: { id: 'litecoin', scheme: 'litecoin', label: 'Litecoin', ticker: 'LTC', decimals: 8 },
};

export function addressFor(coin) {
  if (coin === 'btc') return config.crypto.btcAddress;
  if (coin === 'ltc') return config.crypto.ltcAddress;
  return '';
}

// mempool.space-style block explorers, so an admin can verify a payment in one tap.
const EXPLORERS = {
  btc: 'https://mempool.space/address/',
  ltc: 'https://litecoinspace.org/address/',
};

export function explorerUrl(coin) {
  const base = EXPLORERS[coin];
  const addr = addressFor(coin);
  return base && addr ? base + addr : null;
}

export function isCoinAvailable(coin) {
  return Boolean(addressFor(coin));
}

// Lightweight 60s price cache so rapid clicks don't hammer CoinGecko.
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

// Convert a USD-cents total into a crypto amount string (fixed decimals).
export async function quote(coin, usdCents) {
  const prices = await getPrices();
  const usd = usdCents / 100;
  const amount = usd / prices[coin];
  return amount.toFixed(COINS[coin].decimals);
}

// BIP21-style payment URI (works for both bitcoin: and litecoin: wallets).
export function paymentUri(coin, amount) {
  return `${COINS[coin].scheme}:${addressFor(coin)}?amount=${amount}`;
}

// PNG buffer of the payment URI, for sendPhoto.
export function qrPng(coin, amount) {
  return QRCode.toBuffer(paymentUri(coin, amount), { width: 320, margin: 1 });
}
