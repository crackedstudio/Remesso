import { isMiniPay } from "./wagmi";
import { attributionSuffix } from "./attribution";

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
/// Also carries the Celo attribution tag, because every wallet write in this
/// app already spreads these overrides — which makes this the one place a tag
/// cannot be forgotten on a new transaction.
export function txOverrides(): { type?: "legacy"; dataSuffix?: `0x${string}` } {
  const suffix = attributionSuffix();
  return {
    ...(isMiniPay() ? { type: "legacy" as const } : {}),
    ...(suffix ? { dataSuffix: suffix } : {}),
  };
}
