import { config } from './config.js';

const R_MILES = 3958.8; // Earth radius in miles
const ROAD_FACTOR = 1.3; // straight-line → approximate driving distance

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geocode a free-text address to {lat, lng} using OpenStreetMap Nominatim.
// Returns null if it can't be resolved.
async function geocode(address) {
  const url = `${config.uber.nominatimUrl}?format=json&limit=1&q=${encodeURIComponent(
    address
  )}`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires a descriptive User-Agent / contact.
        'User-Agent': 'heaux-sf-lego-bot/1.0 (contact: ops@heaux.sf)',
        'Accept-Language': 'en',
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return { lat: Number.parseFloat(rows[0].lat), lng: Number.parseFloat(rows[0].lon) };
  } catch {
    return null;
  }
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

  const surchargeCents =
    config.uber.baseCents + Math.round(miles * config.uber.perMileCents);

  return { ok: true, miles: Math.round(miles * 10) / 10, surchargeCents };
}

// Option B helper: turn an admin/expert-entered dollar amount into cents.
export function manualSurchargeCents(dollarsText) {
  const n = Number.parseFloat(String(dollarsText).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}
