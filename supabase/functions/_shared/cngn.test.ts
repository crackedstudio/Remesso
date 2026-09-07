/// Verifies the cNGN crypto against the reference implementations published at
/// https://docs.cngn.co/guides/encryption.
///
/// The interesting half is response decryption, and it cannot be checked by a
/// round trip against ourselves — that would pass even if we had the format
/// wrong in a self-consistent way. So the test plays the role of the cNGN
/// server: it seals payloads to the public key exactly as the docs describe
/// (libsodium crypto_box, `nonce || ciphertext || ephemeral pk`) and requires
/// our client to open them.
///
///   deno test --allow-env --allow-read --allow-write --allow-run --allow-net \
///     supabase/functions/_shared/cngn.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import sodium from "npm:libsodium-wrappers@0.7.15";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const ENCRYPTION_KEY = "test-encryption-key-from-dashboard";

/// A real `ssh-keygen` key, not a hand-built container: the private-key parser
/// looks for OpenSSH's framing, so a synthetic fixture could pass here while
/// every real key failed.
async function generateKeypair(dir: string) {
  const cmd = new Deno.Command("ssh-keygen", {
    args: ["-t", "ed25519", "-C", "api@remesso-test", "-f", `${dir}/key`, "-N", "", "-q"],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return {
    privateKey: await Deno.readTextFile(`${dir}/key`),
    publicLine: await Deno.readTextFile(`${dir}/key.pub`),
  };
}

type CngnModule = typeof import("./cngn.ts");

/// Import the client only after the environment is in place: config.ts reads
/// Deno.env at module evaluation.
async function loadClient(privateKey: string): Promise<CngnModule> {
  Deno.env.set("CNGN_ENCRYPTION_KEY", ENCRYPTION_KEY);
  Deno.env.set("CNGN_SSH_PRIVATE_KEY", privateKey);
  Deno.env.set("CNGN_API_KEY", "cngn_test_abc123");
  return await import("./cngn.ts");
}

/// A distinct module instance, so a test can exercise a different environment
/// without the cached AES and Curve25519 keys from an earlier one.
async function loadFresh(): Promise<CngnModule> {
  return await import(`./cngn.ts?v=${crypto.randomUUID()}`) as CngnModule;
}

/// Seal a payload the way the cNGN platform does.
function sealLikeCngn(publicLine: string, plaintext: string): string {
  const blob = Buffer.from(publicLine.split(" ")[1], "base64");
  // An ssh-ed25519 public blob ends with the raw 32-byte key.
  const ed25519Pk = new Uint8Array(blob.subarray(blob.length - 32));
  const curvePk = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pk);

  const ephemeral = sodium.crypto_box_keypair();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ct = sodium.crypto_box_easy(
    sodium.from_string(plaintext),
    nonce,
    curvePk,
    ephemeral.privateKey,
  );

  const out = new Uint8Array(nonce.length + ct.length + ephemeral.publicKey.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  out.set(ephemeral.publicKey, nonce.length + ct.length);
  return Buffer.from(out).toString("base64");
}

Deno.test("cNGN crypto", async (t) => {
  await sodium.ready;
  const dir = await Deno.makeTempDir();
  const { privateKey, publicLine } = await generateKeypair(dir);
  const cngn = await loadClient(privateKey);

  const aesKey = createHash("sha256").update(ENCRYPTION_KEY).digest();
  const payload = {
    amount: 100000,
    bankCode: "058",
    accountNumber: "0123456789",
    saveDetails: true,
  };

  await t.step("request bodies carry a 16-byte IV", async () => {
    const wire = await cngn.encryptBody(payload);
    assertEquals(Buffer.from(wire.iv, "base64").length, 16);
  });

  await t.step("ciphertext is byte-identical to the docs' Node reference", async () => {
    const wire = await cngn.encryptBody(payload);
    const cipher = createCipheriv("aes-256-cbc", aesKey, Buffer.from(wire.iv, "base64"));
    const reference = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]).toString("base64");
    assertEquals(wire.content, reference);
  });

  await t.step("the platform's AES key derivation opens our ciphertext", async () => {
    const wire = await cngn.encryptBody(payload);
    const d = createDecipheriv("aes-256-cbc", aesKey, Buffer.from(wire.iv, "base64"));
    const plain = Buffer.concat([
      d.update(Buffer.from(wire.content, "base64")),
      d.final(),
    ]).toString("utf8");
    assertEquals(JSON.parse(plain), payload);
  });

  await t.step("a sealed redeemAsset response is opened", async () => {
    const data = {
      trxRef: "RD-3e7a91cf",
      address: "0x1fA2b3C4d5E6f7A8b9C0d1E2f3A4b5C6d7E8f9A0",
    };
    const opened = await cngn.decryptData<typeof data>(
      sealLikeCngn(publicLine, JSON.stringify(data)),
    );
    assertEquals(opened, data);
  });

  await t.step("a full banks list survives the round trip", async () => {
    // ~900 entries is the real size of the CBN list, and large enough to catch
    // a chunking bug in the base64 helpers.
    const banks = Array.from({ length: 900 }, (_, i) => ({
      name: `Bank ${i}`,
      code: String(i).padStart(3, "0"),
    }));
    const opened = await cngn.decryptData<typeof banks>(
      sealLikeCngn(publicLine, JSON.stringify(banks)),
    );
    assertEquals(opened.length, 900);
    assertEquals(opened[57].code, "057");
  });

  await t.step("a tampered payload is rejected, not returned", async () => {
    const bytes = Buffer.from(sealLikeCngn(publicLine, '{"trxRef":"RD-1"}'), "base64");
    bytes[40] ^= 0xff;
    await assertRejects(() => cngn.decryptData(bytes.toString("base64")));
  });

  await t.step("a truncated payload is rejected", async () => {
    await assertRejects(() => cngn.decryptData(Buffer.from("short").toString("base64")));
  });

  await t.step("a non-Ed25519 private key fails loudly at parse time", async () => {
    // Guards the one error a deployment is most likely to make: pasting an RSA
    // key, or a public key, into CNGN_SSH_PRIVATE_KEY.
    const rsaish = "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      Buffer.from("not an ed25519 container at all").toString("base64") +
      "\n-----END OPENSSH PRIVATE KEY-----";
    Deno.env.set("CNGN_SSH_PRIVATE_KEY", rsaish);
    const fresh = await loadFresh();
    await assertRejects(
      () => fresh.decryptData(sealLikeCngn(publicLine, "{}")),
      Error,
      "OpenSSH Ed25519",
    );
    Deno.env.set("CNGN_SSH_PRIVATE_KEY", privateKey);
  });

  await Deno.remove(dir, { recursive: true });
});

Deno.test("escaped newlines in CNGN_SSH_PRIVATE_KEY are tolerated", async () => {
  await sodium.ready;
  const dir = await Deno.makeTempDir();
  const { privateKey, publicLine } = await generateKeypair(dir);

  // Secret managers and .env files routinely flatten a PEM to one line.
  Deno.env.set("CNGN_SSH_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
  Deno.env.set("CNGN_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const cngn = await loadFresh();

  const opened = await cngn.decryptData<{ ok: boolean }>(
    sealLikeCngn(publicLine, JSON.stringify({ ok: true })),
  );
  assert(opened.ok);

  await Deno.remove(dir, { recursive: true });
});
