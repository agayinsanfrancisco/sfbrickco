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
  stripe: {
    // Optional at boot so the site can go live before Stripe is connected.
    // Payments stay disabled until both are present (see `enabled`).
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    successUrl: process.env.STRIPE_SUCCESS_URL || 'https://t.me',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'https://t.me',
    get enabled() {
      return Boolean(this.secretKey && this.webhookSecret);
    },
  },
  pricing: {
    unitCents: int('LEGO_UNIT_PRICE_CENTS', 1000),
    bundleQty: int('LEGO_BUNDLE_QTY', 6),
    bundleCents: int('LEGO_BUNDLE_PRICE_CENTS', 4500),
    serviceFeeCents: int('SERVICE_FEE_CENTS', 5000),
  },
  crypto: {
    btcAddress: process.env.BTC_ADDRESS || '',
    ltcAddress: process.env.LTC_ADDRESS || '',
    get enabled() {
      return Boolean(this.btcAddress || this.ltcAddress);
    },
  },
  uber: {
    baseCents: int('UBER_BASE_CENTS', 500),
    perMileCents: int('UBER_PER_MILE_CENTS', 200),
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
