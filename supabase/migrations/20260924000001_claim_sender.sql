-- Binding a wallet to a session was first-come and permanent, which quietly
-- breaks the app on any new origin.
--
-- `senders.wallet_address` is unique, and the row is owned by an anonymous
-- auth user whose session lives in that browser's storage. Move the app to a
-- new domain — ngrok to Vercel, say — and the browser has no session, so a
-- NEW anonymous user is created, and `ensureSender` then tries to insert a row
-- for a wallet that already has one. It fails, there is no sender row, and the
-- UI asks the person to "sign in" — naming a screen that does not exist,
-- because there is no sign-in in this product. Clearing site data or changing
-- phone does the same thing.
--
-- So the wallet is re-claimable by whoever is holding it now. What that costs
-- and why it is acceptable here:
--
--   - It does NOT weaken the money path. The contract checks `msg.sender` for
--     pause and cancel; nothing in this database can move funds. Re-claiming a
--     wallet gets you a view of its schedule list, not its money.
--   - It DOES mean a claim is last-writer-wins rather than first. Neither is a
--     proof: MiniPay cannot sign messages, so SIWE is unavailable to this
--     audience and there is no way to verify ownership at all. First-come was
--     never security, only inconvenience for the wrong person.
--
-- If a signing path ever exists, this is the seam to replace: verify ownership
-- from a signature and drop the re-claim.
create or replace function public.claim_sender(p_wallet text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_wallet text := lower(p_wallet);
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if v_wallet !~ '^0x[a-f0-9]{40}$' then
    raise exception 'not an address: %', p_wallet;
  end if;

  -- Existing wallet: hand it to the caller's session, keeping the row's id so
  -- its schedules, recipients and run history follow it.
  update public.senders
     set auth_user_id = auth.uid()
   where wallet_address = v_wallet
  returning id into v_id;

  if v_id is null then
    -- This session may already hold a different wallet (a second account in
    -- the same browser). Point that row at the new wallet rather than leaving
    -- an orphan, which is what ensureSender did before.
    update public.senders
       set wallet_address = v_wallet
     where auth_user_id = auth.uid()
    returning id into v_id;
  end if;

  if v_id is null then
    insert into public.senders (auth_user_id, wallet_address)
    values (auth.uid(), v_wallet)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.claim_sender(text) from public, anon;
grant execute on function public.claim_sender(text) to authenticated;

comment on function public.claim_sender(text) is
  'Bind a wallet to the calling session, moving it from a previous session if '
  'one held it. Last-writer-wins: MiniPay cannot sign, so ownership cannot be '
  'proven, and nothing here can move money.';
