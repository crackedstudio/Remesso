import { isMiniPay } from "./wagmi";

/// Transaction overrides for the connected wallet.
///
/// MiniPay accepts legacy (type 0) transactions only — it rejects EIP-1559 and
/// handles gas itself through fee abstraction. viem's `celo` chain ships CIP-64
/// serializers and will otherwise produce a typed transaction, so every
/// signature in the app would fail inside the one wallet this product is built
/// for.
///
/// Applied only in MiniPay: a desktop wallet on Celo is better off with the
/// chain's own fee handling than with a legacy transaction we forced on it.
export function txOverrides(): { type?: "legacy" } {
  return isMiniPay() ? { type: "legacy" } : {};
}
