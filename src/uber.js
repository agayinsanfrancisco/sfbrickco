import { config } from './config.js';
import { getIntSetting } from './lib/settings.js';

const R_MILES = 3958.8; // Earth radius in miles
const ROAD_FACTOR = 1.3; // straight-line → approximate driving distance

// Admin-editable rates (#44), falling back to env-derived config.
async function rates() {
  const [baseCents, perMileCents] = await Promise.all([
    getIntSetting('uber_base_cents', config.uber.baseCents),
    getIntSetting('uber_per_mile_cents', config.uber.perMileCents),
  ]);
  return { baseCents, perMileCents };
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geocode cache: addresses repeat (a builder's base address is geocoded on
// every job), and Nominatim's ToS asks for ≤1 req/s + caching. Keyed by
// normalized address; entries are effectively immutable so no TTL.
const geocodeCache = new Map();

// Geocode a free-text address to {lat, lng} using OpenStreetMap Nominatim.
// Returns null if it can't be resolved.
async function geocode(address) {
  const key = String(address).trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const url = `${config.uber.nominatimUrl}?format=json&limit=1&q=${encodeURIComponent(address)}`;
  let result = null;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires a descriptive User-Agent with contact info.
        'User-Agent': `sfbrickco-bot/1.0 (contact: ${config.uber.contactEmail})`,
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(config.uber.geocodeTimeoutMs),
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length) {
        result = { lat: Number.parseFloat(rows[0].lat), lng: Number.parseFloat(rows[0].lon) };
      }
    }
  } catch {
    result = null; // timeout / network — fall back to manual flow
  }
  if (result) geocodeCache.set(key, result); // only cache successful resolutions
  return result;
}

// Option A: estimate the surcharge from distance.
// Returns { ok: true, miles, surchargeCents } or { ok: false } so the caller
// can fall back to the manual flow (option B).
export async function estimateSurcharge(address) {
  const dest = await geocode(address);
  if (!dest) return { ok: false };

  const miles =
    haversineMiles(config.uber.originLat, config.uber.originLng, dest.lat, dest.lng) *
    ROAD_FACTOR;

  const { baseCents, perMileCents } = await rates();
  const surchargeCents = baseCents + Math.round(miles * perMileCents);
  const rounded = Math.round(miles * 10) / 10;

  // Out-of-area cap (#40): caller decides whether to reject.
  return { ok: true, miles: rounded, surchargeCents, tooFar: miles > config.uber.maxMiles };
}

// Estimate the surcharge between two free-text addresses (builder → customer).
// Returns { ok, miles, surchargeCents } or { ok: false } if either can't geocode.
export async function estimateBetween(originAddress, destAddress) {
  const [o, d] = await Promise.all([geocode(originAddress), geocode(destAddress)]);
  if (!o || !d) return { ok: false };
  const miles =
    haversineMiles(o.lat, o.lng, d.lat, d.lng) * ROAD_FACTOR;
  const { baseCents, perMileCents } = await rates();
  const surchargeCents = baseCents + Math.round(miles * perMileCents);
  return { ok: true, miles: Math.round(miles * 10) / 10, surchargeCents };
}

// Option B helper: turn an admin/expert-entered dollar amount into cents.
export function manualSurchargeCents(dollarsText) {
  const n = Number.parseFloat(String(dollarsText).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}
