// Generate the VAPID keypair Web Push needs. Run once.
//
//   node scripts/push-keys.mjs
//
// VAPID is how a push service knows the notification came from Operator and not
// from someone who scraped a subscription. The PUBLIC half goes to the browser
// when it subscribes; the PRIVATE half signs every send.
//
// ## Where these go, and why not in the store
//
// The private key is a credential: with it and a subscription, anyone can push
// to his phone. `CLAUDE.md` is explicit — keys never live in
// `data/operator.json`, in git, or reach the client. That file is plaintext and
// served by an API, so a key in it is a key published to the tailnet.
//
// **And never type it into Operator's own terminal**, which logs every command
// it runs. The Gemini key had to be reissued for exactly that. Set it from a
// normal shell at the desk.
//
// P-256 (prime256v1) because the Web Push spec says so; no other curve works.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/*
  The public key must be the raw uncompressed EC point (65 bytes, 0x04 || X ||
  Y), not the DER SubjectPublicKeyInfo Node hands back. The last 65 bytes of the
  DER encoding are exactly that point.
*/
const der = publicKey.export({ type: "spki", format: "der" });
const raw = der.subarray(der.length - 65);

/*
  The private key is exported as PKCS8 PEM, then base64'd whole. Keeping the
  container rather than extracting the 32-byte scalar means it can be handed
  straight back to `createPrivateKey` with no reassembly — one less place to get
  an encoding subtly wrong.
*/
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });

const b64url = (buf) => Buffer.from(buf).toString("base64url");

console.log("Set these from a normal shell — NOT from Operator's terminal:\n");
console.log(`setx OPERATOR_VAPID_PUBLIC ${b64url(raw)}`);
console.log(`setx OPERATOR_VAPID_PRIVATE ${b64url(pkcs8)}`);
console.log(`setx OPERATOR_VAPID_SUBJECT mailto:tosin.404@protonmail.com`);
console.log("\nThen restart the server so it reads them.");
console.log("\nThe public key is not secret — the browser needs it to subscribe.");
console.log("The private key is. Regenerating it invalidates every subscription,");
console.log("so every device has to re-subscribe.");
