"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { fetchBanks, verifyAccount, type AccountDetails } from "@/lib/api";
import { BANK_PAYOUTS_ENABLED, DIRECT_TOKENS, type TokenInfo } from "@/lib/config";
import { isMiniPay } from "@/lib/wagmi";
import type { PayoutKind } from "@/lib/types";

export type RecipientDraft = {
  displayName: string;
  payoutType: PayoutKind;
  walletAddress: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /// Direct rail only: which stablecoin the recipient actually receives.
  token: TokenInfo;
};

export const emptyRecipient: RecipientDraft = {
  displayName: "",
  payoutType: "direct",
  walletAddress: "",
  bankCode: "",
  accountNumber: "",
  accountName: "",
  token: DIRECT_TOKENS[0], // USDT — the one every MiniPay user already holds
};

export function recipientIsComplete(r: RecipientDraft): boolean {
  if (!r.displayName.trim()) return false;
  if (r.payoutType === "ngn_bank") {
    return Boolean(r.bankCode && /^[0-9]{10}$/.test(r.accountNumber) && r.accountName);
  }
  return isAddress(r.walletAddress);
}

export function RecipientStep({
  value,
  onChange,
}: {
  value: RecipientDraft;
  onChange: (r: RecipientDraft) => void;
}) {
  const set = (patch: Partial<RecipientDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Who is this for?</label>
        <input
          className="field"
          placeholder="Mum"
          value={value.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
        />
      </div>

      <div>
        <label className="label">How should they receive it?</label>
        <div className="grid grid-cols-3 gap-2">
          <Choice
            active={value.payoutType === "direct"}
            onClick={() => set({ payoutType: "direct" })}
            title="Stablecoin"
            subtitle="Visible in MiniPay"
          />
          <Choice
            active={value.payoutType === "wallet"}
            onClick={() => set({ payoutType: "wallet" })}
            title="cNGN"
            subtitle="Not shown in MiniPay"
          />
          <Choice
            active={value.payoutType === "ngn_bank"}
            onClick={() => BANK_PAYOUTS_ENABLED && set({ payoutType: "ngn_bank" })}
            disabled={!BANK_PAYOUTS_ENABLED}
            title="Bank"
            subtitle={BANK_PAYOUTS_ENABLED ? "Naira" : "Unavailable"}
          />
        </div>

        {value.payoutType === "direct" && (
          <div className="mt-3">
            <label className="label">Which asset</label>
            <div className="grid grid-cols-3 gap-2">
              {DIRECT_TOKENS.map((t) => (
                <button
                  key={t.symbol}
                  type="button"
                  onClick={() => set({ token: t })}
                  className={`rounded-lg border px-3 py-2 text-sm transition ${
                    value.token.symbol === t.symbol
                      ? "border-ink bg-ink text-white"
                      : "border-black/15 bg-white hover:bg-black/[0.03]"
                  }`}
                >
                  {t.symbol}
                </button>
              ))}
            </div>
            <p className="hint">
              No conversion happens — you send {value.token.symbol} and they receive
              {" "}{value.token.symbol}. All three show up in MiniPay.
            </p>
          </div>
        )}

        {/* The honest reason the cNGN option is second, not first. */}
        {value.payoutType === "wallet" && (
          <p className="hint text-amber-700">
            MiniPay only displays USDT, USDC and cUSD. A recipient paid in cNGN
            will see nothing in their wallet, and MiniPay has no way to add a
            custom token. Prefer Stablecoin unless they use another wallet.
          </p>
        )}
        {!BANK_PAYOUTS_ENABLED && (
          <p className="hint">
            Bank payouts are switched off because the cNGN redemption address has not been
            confirmed as stable for this account. Until it is, a schedule could be
            authorised to send to an address that later stops being the right one.
          </p>
        )}
      </div>

      {value.payoutType !== "ngn_bank" ? (
        <div>
          <label className="label">Recipient wallet</label>
          <input
            className="field mono"
            placeholder="0x…"
            spellCheck={false}
            value={value.walletAddress}
            onChange={(e) => set({ walletAddress: e.target.value.trim() })}
          />
          {value.walletAddress && !isAddress(value.walletAddress) && (
            <p className="hint text-red-600">That is not a valid address.</p>
          )}
          <p className="hint">
            This address is fixed on-chain when you sign. Changing it later means
            cancelling this schedule and creating a new one — which is the point.
          </p>
        </div>
      ) : (
        <BankFields value={value} set={set} />
      )}
    </div>
  );
}

function BankFields({
  value,
  set,
}: {
  value: RecipientDraft;
  set: (p: Partial<RecipientDraft>) => void;
}) {
  const banks = useQuery({
    queryKey: ["banks"],
    queryFn: fetchBanks,
    // The list changes a few times a year and the API allows 20 calls a minute.
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any edit invalidates a previous verification: the name on file belongs to
  // the exact bank-and-number pair that was checked, not to the form.
  useEffect(() => {
    if (value.accountName) set({ accountName: "" });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.bankCode, value.accountNumber]);

  const canCheck = Boolean(value.bankCode) && /^[0-9]{10}$/.test(value.accountNumber);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const details: AccountDetails = await verifyAccount(value.bankCode, value.accountNumber);
      set({ accountName: details.accountName });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Bank</label>
        <select
          className="field"
          value={value.bankCode}
          disabled={banks.isLoading || banks.isError}
          onChange={(e) => set({ bankCode: e.target.value })}
        >
          <option value="">
            {banks.isLoading ? "Loading banks…" : banks.isError ? "Could not load banks" : "Choose a bank"}
          </option>
          {banks.data?.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
        {banks.isError && <p className="hint text-red-600">{(banks.error as Error).message}</p>}
      </div>

      <div>
        <label className="label">Account number</label>
        <input
          className="field mono"
          inputMode="numeric"
          maxLength={10}
          placeholder="0123456789"
          value={value.accountNumber}
          onChange={(e) => set({ accountNumber: e.target.value.replace(/\D/g, "").slice(0, 10) })}
        />
      </div>

      {value.accountName ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <p className="text-xs uppercase tracking-wide text-emerald-800/70">Account name</p>
          <p className="mt-0.5 font-medium text-emerald-900">{value.accountName}</p>
          <p className="mt-1 text-xs text-emerald-900/70">
            Confirm this is the right person before continuing. Naira sent to a Nigerian
            bank account cannot be recalled.
          </p>
        </div>
      ) : (
        <button className="btn-ghost w-full" disabled={!canCheck || checking} onClick={check}>
          {checking ? "Checking with the bank…" : "Verify account"}
        </button>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "border-ink bg-ink text-white" : "border-black/15 bg-white hover:bg-black/[0.03]"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className={`block text-xs ${active ? "text-white/60" : "text-black/50"}`}>
        {subtitle}
      </span>
    </button>
  );
}
