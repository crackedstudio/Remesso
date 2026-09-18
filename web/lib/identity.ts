/// Names for addresses, because MiniPay forbids showing the address.
///
/// The rule is strict and it is not about primary identifiers: no address text
/// anywhere in the app, no copy button, no QR, and a truncated `0x1234…abcd` is
/// explicitly not an escape hatch. MiniPay's users are largely first-time app
/// users; a hex string reads as an error, not as a name.
///
/// So every address gets a stable, human-readable label derived from the
/// address itself. Deterministic, so the same recipient reads the same way on
/// every screen and every session, with no storage.

const ADJECTIVES = [
  "Amber", "Brave", "Calm", "Clever", "Eager", "Gentle", "Golden", "Happy",
  "Kind", "Lively", "Lucky", "Noble", "Proud", "Quiet", "Rapid", "Silver",
  "Smooth", "Sunny", "Swift", "Warm", "Wise", "Bright", "Bold", "Steady",
] as const;

const NOUNS = [
  "Almond", "Anchor", "Beacon", "Cedar", "Cocoa", "Comet", "Coral", "Delta",
  "Falcon", "Harbour", "Indigo", "Island", "Lantern", "Maple", "Meadow",
  "Olive", "Orchid", "Pebble", "Quartz", "River", "Summit", "Willow",
  "Zephyr", "Harvest",
] as const;

/// FNV-1a. Not a hash for security — just a stable spread across the word list
/// so two different addresses rarely collide on screen.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/// A stable two-word name for an address. Never returns the address.
export function addressName(address?: string | null): string {
  if (!address) return "Unknown";
  const h = hash(address.toLowerCase());
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length];
  return `${adj} ${noun}`;
}

/// What to call a recipient: the name the sender gave them, else a generated
/// one. The address is never a fallback.
export function recipientLabel(
  givenName?: string | null,
  address?: string | null,
): string {
  const n = givenName?.trim();
  return n || addressName(address);
}
