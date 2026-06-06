import { getAllSettings } from '../supabase.js';

// Admin-editable settings with a short in-memory cache so the pricing path
// doesn't hit the DB on every call. Falls back to the env-derived config value.
let cache = { at: 0, map: null };

async function load() {
  if (cache.map && Date.now() - cache.at < 60_000) return cache.map;
  const rows = await getAllSettings();
  cache = { at: Date.now(), map: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache.map;
}

export async function getIntSetting(key, fallback) {
  let map;
  try {
    map = await load();
  } catch {
    return fallback; // never let a settings lookup break pricing
  }
  const n = Number.parseInt(map[key], 10);
  return Number.isNaN(n) ? fallback : n;
}

export function invalidateSettings() {
  cache = { at: 0, map: null };
}
