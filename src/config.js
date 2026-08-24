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
    serviceFeeCents: int('SERVICE_FEE_CENTS', 4000),
    platformFeePct: int('PLATFORM_FEE_PCT', 30), // platform's cut of a Block Expert's rate
  },
  crypto: {
    // Preferred: account xpub/zpub (BIP84 native segwit) → unique address per
    // order + automatic on-chain confirmation via the watcher.
    btcXpub: process.env.BTC_XPUB || '',
    ltcXpub: process.env.LTC_XPUB || '',
    // Fallback: a single static address (manual admin confirmation).
    btcAddress: process.env.BTC_ADDRESS || '',
    ltcAddress: process.env.LTC_ADDRESS || '',
    // How long a quoted rate + address stays valid (minutes → ms).
    quoteTtlMs: int('QUOTE_TTL_MINUTES', 15) * 60 * 1000,
    // Accept a payment that lands within this fraction of the quote (covers
    // wallet fee rounding / minor rate drift). 0.995 = accept ≥ 99.5%.
    fundedTolerance: Number.parseFloat(process.env.PAYMENT_TOLERANCE || '0.995'),
    // Timeout for external HTTP (price feed + block explorers), ms.
    httpTimeoutMs: int('CRYPTO_HTTP_TIMEOUT_MS', 8000),
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
    geocodeTimeoutMs: int('GEOCODE_TIMEOUT_MS', 6000),
    maxMiles: int('MAX_DELIVERY_MILES', 30), // reject out-of-area beyond this
    contactEmail: process.env.CONTACT_EMAIL || 'ops@sfbrickco.com',
  },
  server: {
    port: int('PORT', 3000),
    // Web admin dashboard access token. Unset = /admin is disabled (404).
    adminToken: process.env.ADMIN_DASH_TOKEN || '',
  },
  cleanup: {
    // Auto-cancel unpaid orders/bookings older than this (abandoned-order sweep).
    abandonAfterMs: int('ABANDON_AFTER_HOURS', 24) * 60 * 60 * 1000,
  },
  session: {
    ttlMs: int('SESSION_TTL_MINUTES', 30) * 60 * 1000, // idle session expiry
  },
  rateLimit: {
    max: int('RATE_LIMIT_MAX', 20), // max messages/callbacks per window per user
    windowMs: int('RATE_LIMIT_WINDOW_MS', 10000),
  },
  adminIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n)), // ignore @handles / junk so admin never silently breaks
};

export function isAdminId(telegramId) {
  return config.adminIds.includes(Number(telegramId));
}

// Non-fatal startup checks (#10). Returns a list of warning strings.
export function validateConfig() {
  const warnings = [];
  if (!config.crypto.enabled) {
    warnings.push('No crypto payment method configured (set BTC_XPUB/LTC_XPUB or a static address).');
  }
  if (!config.adminIds.length) {
    warnings.push('No ADMIN_TELEGRAM_IDS set — admin panel + payment confirmations are unreachable.');
  }
  return warnings;
}
