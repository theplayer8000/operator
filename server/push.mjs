// Web Push, implemented against the RFCs with Node built-ins only.
//
// Replaces `notify.mjs`'s POST to a local ntfy server. Same idea — get a line
// onto his phone when a turn needs him — reached a different way.
//
// ## Why not the `web-push` npm package
//
// `CLAUDE.md`: everything outside `runner.mjs` stays pure Node "so that what
// serves your data is still readable end to end", and a server dependency needs
// an ADR naming the package and what it buys. What it would buy here is ~120
// lines, all of it standard-library crypto. `node:crypto` has P-256 ECDH,
// HKDF, AES-128-GCM and ECDSA — every primitive the spec asks for.
//
// ## What actually leaves the machine
//
// This is the honest accounting, because the reason for the switch was reducing
// what a third party sees.
//
// A push service (Apple's `web.push.apple.com` for iOS, Google/Mozilla/
// Microsoft elsewhere) is unavoidable: it is how a sleeping OS is woken. It
// receives the subscription endpoint, an encrypted blob, and the time.
//
// **It cannot read the notification.** RFC 8291 encryption is mandatory and the
// key is derived from a secret shared only between this server and the browser
// that subscribed. Apple sees ciphertext, not the title, not the body.
//
// Against ntfy, which saw a message id and a topic hash: comparable metadata,
// strictly less content, and one fewer service to run. It is a swap, not an
// elimination — there is no version of push where nobody is in the path.
//
// ## The specs
//
//   RFC 8188  aes128gcm content encoding — the framing
//   RFC 8291  Message Encryption for Web Push — the key derivation
//   RFC 8292  VAPID — proving the send came from Operator

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  createSign,
  randomBytes,
} from "node:crypto";

const env = (name) => (process.env[name] ?? "").replace(/^﻿/, "").trim();

const PUBLIC_KEY = env("OPERATOR_VAPID_PUBLIC");
const PRIVATE_KEY = env("OPERATOR_VAPID_PRIVATE");
const SUBJECT = env("OPERATOR_VAPID_SUBJECT") || "mailto:operator@localhost";

/** Whether push can be sent at all. Read by callers before bothering. */
export const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);

/** The browser needs this to subscribe. Not secret. */
export const publicKey = PUBLIC_KEY;

/** Long enough for a push service round trip, short enough never to hold a turn. */
const TIMEOUT_MS = 5000;

// ------------------------------------------------------------------ HKDF

/**
 * HKDF, the two halves the spec uses by name.
 *
 * Node has `hkdf`, but only as a callback/promise API over the whole
 * extract-then-expand flow, and RFC 8291 needs the two steps SEPARATELY — it
 * feeds the output of one expand back in as the input keying material of the
 * next extract. Two four-line helpers are clearer than bending the built-in.
 */
const extract = (salt, ikm) => createHmac("sha256", salt).update(ikm).digest();

const expand = (prk, info, length) =>
  createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);

// ------------------------------------------------------------------ VAPID

/**
 * The signed assertion that says "Operator sent this".
 *
 * ES256 over a JWT whose audience is the push service's ORIGIN — not the full
 * endpoint. Apple rejects a token whose `aud` carries the path, with a 400 that
 * says nothing useful about why.
 */
function vapidHeader(endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    // Twelve hours. The spec caps it at 24; going close to the limit means a
    // clock a few minutes fast on either end becomes a rejected token.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: SUBJECT,
  };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${b64(header)}.${b64(claims)}`;

  const key = createPrivateKey({
    key: Buffer.from(PRIVATE_KEY, "base64url"),
    format: "der",
    type: "pkcs8",
  });

  /*
    `ieee-p1363`, NOT the default.

    Node signs ECDSA as DER by default, and JWS requires the raw r||s pair. A
    DER signature is accepted by nothing and the error is a flat 401 — the
    single easiest way to spend an afternoon on this.
  */
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key, dsaEncoding: "ieee-p1363" });

  return {
    Authorization: `vapid t=${signingInput}.${signature.toString("base64url")}, k=${PUBLIC_KEY}`,
  };
}

// ------------------------------------------------------------------ payload

/**
 * Encrypt one message for one subscription (RFC 8291 §3.4, RFC 8188 §2).
 *
 * The whole point of this function: the push service carries the result and
 * cannot read it. The key comes from an ECDH between a keypair generated here,
 * for this one message, and the public key the browser produced when it
 * subscribed — mixed with `auth`, a secret the browser generated and only this
 * server ever received.
 */
function encrypt(payload, subscription) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");

  // A fresh keypair per message. Reusing one would let two messages to the same
  // device share a key, which is the property the spec exists to avoid.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  /*
    The two-stage derivation. The first stage binds the key to BOTH public keys
    by name, which is what stops a shared secret from one exchange being
    replayed into another.
  */
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ]);
  const ikm = expand(extract(authSecret, shared), keyInfo, 32);

  const salt = randomBytes(16);
  const prk = extract(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);

  /*
    `0x02` is the padding delimiter marking the LAST record. One record is
    always enough here — these are notifications, not documents — but the byte
    is not optional: without it the browser rejects the message as truncated.
  */
  const record = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // The aes128gcm header: salt, record size, key length, key — then the body.
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);

  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
  ]);
}

// ------------------------------------------------------------------ send

/**
 * Push one message to one subscription.
 *
 * @returns {Promise<{ok: boolean, gone?: boolean, status?: number, error?: string}>}
 *   `gone` means the push service says this subscription is dead — the app was
 *   deleted or permission revoked. The caller should forget it rather than
 *   retrying forever against an endpoint that will never work again.
 */
export async function sendTo(subscription, payload, { ttl = 3600, urgency = "high" } = {}) {
  if (!configured) return { ok: false, error: "no VAPID keys" };

  let body;
  try {
    body = encrypt(payload, subscription);
  } catch (err) {
    // A malformed subscription is permanently broken, not a transient failure.
    return { ok: false, gone: true, error: `could not encrypt: ${err?.message ?? err}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        ...vapidHeader(subscription.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
      signal: controller.signal,
    });

    /*
      404 and 410 are the push service saying this endpoint is retired. Anything
      else — including a 5xx — is this send failing, not the subscription.
      Getting that distinction wrong means either notifications that silently
      stop, or a dead endpoint retried on every event forever.
    */
    if (res.status === 404 || res.status === 410) {
      return { ok: false, gone: true, status: res.status };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}
