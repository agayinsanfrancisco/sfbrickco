import { config } from './config.js';

// Uber Direct (Uber's business courier API) — auto-dispatch a delivery when an
// admin accepts a paid order. Activates only when all credentials are present;
// otherwise dispatch falls back to a manual message.
//
// NOTE: this path is built but unverified against the live API until real
// credentials + a test delivery exist (Uber Direct needs merchant onboarding).

export function enabled() {
  return config.uberDirect.enabled;
}

let _token = { value: null, exp: 0 };

async function getToken() {
  if (_token.value && Date.now() < _token.exp) return _token.value;
  const body = new URLSearchParams({
    client_id: config.uberDirect.clientId,
    client_secret: config.uberDirect.clientSecret,
    grant_type: 'client_credentials',
    scope: 'eats.deliveries',
  });
  const res = await fetch('https://auth.uber.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`uber auth ${res.status}`);
  const j = await res.json();
  _token = { value: j.access_token, exp: Date.now() + ((j.expires_in || 2592000) - 60) * 1000 };
  return _token.value;
}

// Create a delivery from the store (pickup) to the customer (dropoff).
// Returns { id, trackingUrl }.
export async function createDelivery({ dropoffName, dropoffAddress, dropoffPhone, items }) {
  const token = await getToken();
  const payload = {
    pickup_name: config.uberDirect.pickupName,
    pickup_address: config.uberDirect.pickupAddress,
    pickup_phone_number: config.uberDirect.pickupPhone,
    dropoff_name: dropoffName || 'Customer',
    dropoff_address: dropoffAddress,
    dropoff_phone_number: dropoffPhone || config.uberDirect.pickupPhone,
    manifest_items: (items || []).map((it) => ({
      name: it.name,
      quantity: it.quantity,
    })),
  };
  const res = await fetch(
    `https://api.uber.com/v1/customers/${config.uberDirect.customerId}/deliveries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`uber delivery ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return { id: j.id, trackingUrl: j.tracking_url };
}
