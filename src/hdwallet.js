import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

// Derive a fresh native-segwit (bech32, p2wpkh) receive address per order from
// an account-level extended public key (BIP84 m/84'/coin'/0'). Pure-JS, no node.
//
// Wallets export this key with different "human" version bytes (xpub / zpub /
// ypub for BTC; Ltub / Mtub / zpub for LTC). The underlying key is identical —
// the version bytes only signal intended script type. We normalise to the
// standard xpub version so @scure/bip32 accepts it, then choose the address
// HRP per coin. We always derive p2wpkh because the wallets in use are bech32.

const b58c = base58check(sha256);
const XPUB_VERSION = Uint8Array.from([0x04, 0x88, 0xb2, 0x1e]); // mainnet xpub

const HRP = { btc: 'bc', ltc: 'ltc' };

// Re-encode any extended-pubkey version to standard xpub so HDKey accepts it.
function normaliseToXpub(extKey) {
  const data = b58c.decode(extKey); // 78 bytes: version(4)+payload(74)
  if (data.length !== 78) throw new Error('bad extended key length');
  const out = new Uint8Array(data);
  out.set(XPUB_VERSION, 0);
  return b58c.encode(out);
}

function p2wpkhAddress(pubkey, coin) {
  const hrp = HRP[coin];
  if (!hrp) throw new Error(`unsupported coin: ${coin}`);
  const h160 = ripemd160(sha256(pubkey)); // 20-byte witness program
  const words = [0, ...bech32.toWords(h160)]; // witness v0 + program
  return bech32.encode(hrp, words);
}

// External-chain address at the given index: m/84'/coin'/0'/0/index
export function deriveAddress(coin, accountExtPubKey, index) {
  const hd = HDKey.fromExtendedKey(normaliseToXpub(accountExtPubKey));
  const child = hd.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('could not derive public key');
  return p2wpkhAddress(child.publicKey, coin);
}
