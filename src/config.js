import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
  },
  supabase: {
    url: required('SUPABASE_URL'),
    serviceKey: required('SUPABASE_SERVICE_KEY'),
  },
  pricing: {
    unitCents: int('LEGO_UNIT_PRICE_CENTS', 1000),
    bundleQty: int('LEGO_BUNDLE_QTY', 6),
    bundleCents: int('LEGO_BUNDLE_PRICE_CENTS', 4500),
    serviceFeeCents: int('SERVICE_FEE_CENTS', 5000),
  },
  crypto: {
    // Preferred: account xpub/zpub (BIP84 native segwit) → unique address per
    // order + automatic on-chain confirmation via the watcher.
    btcXpub: process.env.BTC_XPUB || '',
    ltcXpub: process.env.LTC_XPUB || '',
    // Fallback: a single static address (manual admin confirmation).
    btcAddress: process.env.BTC_ADDRESS || '',
    ltcAddress: process.env.LTC_ADDRESS || '',
    get enabled() {
      return Boolean(this.btcXpub || this.ltcXpub || this.btcAddress || this.ltcAddress);
    },
  },
  uber: {
    baseCents: int('UBER_BASE_CENTS', 500),
    perMileCents: int('UBER_PER_MILE_CENTS', 200),
    flatFallbackCents: int('UBER_FLAT_FALLBACK_CENTS', 1500),
    originLat: Number.parseFloat(process.env.CIVIC_CENTER_LAT || '37.7793'),
    originLng: Number.parseFloat(process.env.CIVIC_CENTER_LNG || '-122.4193'),
    nominatimUrl:
      process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search',
  },
  server: {
    port: int('PORT', 3000),
  },
  adminIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10)),
};

export function isAdminId(telegramId) {
  return config.adminIds.includes(Number(telegramId));
}
