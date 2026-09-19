/// Verifies our Svix signature check against the `svix` library itself — the
/// library Self's own SDK delegates to.
///
/// A round trip against ourselves would pass even with the signed-content
/// format wrong in a self-consistent way. So the test plays Self: it signs with
/// `svix`'s own `Webhook.sign` and requires `verifyWebhook` to accept exactly
/// what that library would, and reject what it would reject.
///
///   deno test --allow-env supabase/functions/_shared/self.test.ts
import { assert, assertFalse } from "jsr:@std/assert@1";
import { Webhook } from "npm:svix@1.92.2";
import { verifyWebhook } from "./self.ts";

// Any base64 body behind the prefix is a valid Svix secret.
const SECRET = "whsec_" + btoa("remesso-self-webhook-test-secret!");
const BODY = JSON.stringify({
  type: "verification.completed",
  verification_id: "7f3b2a1e-9c4d-4b2a-8e1f-2c6d5a4b3c2d",
  external_uuid: "a8f6d1c2-0000-4000-8000-000000000001",
  status: "valid",
  nullifier: "123456789",
});

function signed(body: string, at: Date, id = "msg_2abc") {
  const sig = new Webhook(SECRET).sign(id, at, body);
  const ts = String(Math.floor(at.getTime() / 1000));
  return {
    headers: new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": sig }),
    now: Math.floor(at.getTime() / 1000),
  };
}

Deno.test("accepts a delivery svix signed", async () => {
  const { headers, now } = signed(BODY, new Date());
  assert(await verifyWebhook(BODY, headers, SECRET, now));
  // And svix agrees, so the fixture itself is sound.
  new Webhook(SECRET).verify(BODY, Object.fromEntries(headers));
});

Deno.test("rejects a body altered after signing", async () => {
  const { headers, now } = signed(BODY, new Date());
  assertFalse(await verifyWebhook(BODY.replace("valid", "invalid"), headers, SECRET, now));
});

Deno.test("rejects a signature made with another secret", async () => {
  const { headers, now } = signed(BODY, new Date());
  const other = "whsec_" + btoa("some-other-endpoint-secret-value");
  assertFalse(await verifyWebhook(BODY, headers, other, now));
});

Deno.test("rejects a replay outside the five-minute window", async () => {
  const at = new Date();
  const { headers, now } = signed(BODY, at);
  assertFalse(await verifyWebhook(BODY, headers, SECRET, now + 6 * 60));
  assertFalse(await verifyWebhook(BODY, headers, SECRET, now - 6 * 60));
});

Deno.test("accepts when any one of several signatures matches (secret rotation)", async () => {
  const { headers, now } = signed(BODY, new Date());
  const real = headers.get("svix-signature")!;
  headers.set("svix-signature", `v1,${btoa("stale-signature-from-old-secret")} ${real}`);
  assert(await verifyWebhook(BODY, headers, SECRET, now));
});

Deno.test("rejects missing headers and an empty secret", async () => {
  const { headers, now } = signed(BODY, new Date());
  assertFalse(await verifyWebhook(BODY, new Headers(), SECRET, now));
  assertFalse(await verifyWebhook(BODY, headers, "", now));
});
