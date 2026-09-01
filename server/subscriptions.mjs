// Which devices have asked to be notified.
//
// ## Why this is its own file and not a slice of operator.json
//
// A subscription carries `keys.auth` — a secret the browser generated so that
// only this server can encrypt for it. Combined with the VAPID private key it
// is the full ability to push to his phone.
//
// `data/operator.json` is served by `GET /api/state/<key>`. Authenticated, yes,
// but every device on the tailnet that can open the app can read every slice,
// and a worker has Write everywhere. Putting a per-device secret in there makes
// it readable by anything that can already read his gym log, which is the wrong
// blast radius for a different kind of thing.
//
// So: a separate file, never routed, same reasoning as `uploads.mjs` staging
// attachments outside the store.
//
// No dependencies.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.env.OPERATOR_PUSH_FILE ?? join(ROOT, "data", "push.json");

/** In memory, same pattern as store.mjs: one copy, written through. */
let subscriptions = null;

async function load() {
  if (subscriptions) return subscriptions;
  try {
    subscriptions = JSON.parse(await readFile(FILE, "utf8"));
    if (!Array.isArray(subscriptions)) subscriptions = [];
  } catch {
    subscriptions = [];
  }
  return subscriptions;
}

/*
  Write to a temp file then rename.

  A half-written subscriptions file reads as zero subscriptions, which is
  indistinguishable from "he never subscribed" and would be discovered only by
  notifications quietly stopping. `.tmp` collisions between concurrent writers
  caused a real bug in the store on 2026-08-31, so the name carries the pid.
*/
async function save() {
  await mkdir(dirname(FILE), { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(subscriptions, null, 2));
  await rename(temp, FILE);
}

/** Every registered device. */
export async function list() {
  return [...(await load())];
}

/**
 * Register a device, or refresh one already known.
 *
 * Keyed on the endpoint, which is what the push service issues and what
 * identifies the installation. Re-subscribing on the same device produces the
 * same endpoint, so this is an upsert rather than a second row — otherwise
 * every reinstall would double his notifications.
 */
export async function add(subscription, label = "a device") {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("not a usable push subscription");
  }
  const all = await load();
  const existing = all.findIndex((s) => s.endpoint === subscription.endpoint);
  const row = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    label,
    addedAt: new Date().toISOString(),
  };
  if (existing >= 0) all[existing] = { ...all[existing], ...row };
  else all.push(row);
  await save();
  return { registered: true, devices: all.length };
}

/** Forget one device — on unsubscribe, or when the push service says it is gone. */
export async function remove(endpoint) {
  const all = await load();
  const before = all.length;
  subscriptions = all.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) await save();
  return { removed: before - subscriptions.length };
}
