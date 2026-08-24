import crypto from 'node:crypto';

// Read-the-terms gate. The bot and the Express server run in one process, so
// this in-memory map is shared: the confirm card links to
// /terms/<kind>?k=<token>, the page hit marks the token viewed, and the Agree
// tap is refused until then. A restart just means re-tapping the link.

const TTL_MS = 24 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { chatId, viewed, at }
const byChat = new Map(); // chatId -> latest token

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [t, rec] of tokens) if (rec.at < cutoff) tokens.delete(t);
}

// New token for this chat's current checkout. Re-issuing resets the gate.
export function issueTermsToken(chatId) {
  prune();
  const token = crypto.randomBytes(8).toString('hex');
  tokens.set(token, { chatId, viewed: false, at: Date.now() });
  byChat.set(chatId, token);
  return token;
}

// Called by the web route when the terms page is opened.
export function markTermsViewed(token) {
  const rec = tokens.get(token);
  if (rec) rec.viewed = true;
  return Boolean(rec);
}

export function hasViewedTerms(chatId) {
  const rec = tokens.get(byChat.get(chatId));
  return Boolean(rec?.viewed);
}
