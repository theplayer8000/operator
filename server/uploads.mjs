// Local file resources for Claude jobs. Binaries stay outside operator.json.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE_DIR = resolve(process.env.OPERATOR_RESOURCE_DIR ?? join(ROOT, "data", "job-resources"));
const STAGING_DIR = join(RESOURCE_DIR, "staging");
const MAX_BYTES = Math.max(1, Number(process.env.OPERATOR_RESOURCE_MAX_BYTES ?? 10 * 1024 * 1024) || 10 * 1024 * 1024);

function safeName(value) {
  const name = basename(String(value ?? "")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!name || name === "." || name === "..") throw new Error("file name is required");
  return name.slice(0, 180);
}

function safeJobId(id) {
  if (!/^job-\d+$/.test(String(id))) throw new Error("invalid job id");
  return String(id);
}

function publicResource(resource) {
  return { id: resource.id, name: resource.name, type: resource.type, size: resource.size, path: resource.path, createdAt: resource.createdAt };
}

function readUpload(req) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`file is larger than the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB limit`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error(`file is larger than the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB limit`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Stage a browser-selected file until a job claims it on its first turn. */
export async function stageUpload(req) {
  const name = safeName(req.headers["x-operator-file-name"]);
  const bytes = await readUpload(req);
  if (bytes.length === 0) throw new Error("file is empty");
  const id = `resource-${randomUUID()}`;
  const path = join(STAGING_DIR, `${id}-${name}`);
  await mkdir(STAGING_DIR, { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return publicResource({ id, name, type: String(req.headers["content-type"] ?? "application/octet-stream").slice(0, 200), size: bytes.length, path, createdAt: new Date().toISOString() });
}

/** Move staged resources into a job-owned directory. */
export async function claimResources(jobId, candidates) {
  const safeId = safeJobId(jobId);
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const target = join(RESOURCE_DIR, safeId);
  await mkdir(target, { recursive: true });
  const claimed = [];
  for (const candidate of candidates) {
    const id = String(candidate?.id ?? "");
    if (!/^resource-[0-9a-f-]{36}$/.test(id)) throw new Error("invalid uploaded resource");
    const name = safeName(candidate?.name);
    const source = join(STAGING_DIR, `${id}-${name}`);
    if (!source.startsWith(`${STAGING_DIR}\\`) || !existsSync(source)) throw new Error(`uploaded file is no longer available: ${name}`);
    const path = join(target, `${id}-${name}`);
    await rename(source, path);
    claimed.push(publicResource({ id, name, type: String(candidate?.type ?? "application/octet-stream").slice(0, 200), size: Number(candidate?.size) || 0, path, createdAt: candidate?.createdAt ?? new Date().toISOString() }));
  }
  return claimed;
}

/** Remove the local files when their conversation is closed or cleared. */
export async function removeJobResources(jobId) {
  const safeId = safeJobId(jobId);
  const target = join(RESOURCE_DIR, safeId);
  if (!target.startsWith(`${RESOURCE_DIR}\\`)) throw new Error("resource path escaped its root");
  await rm(target, { recursive: true, force: true });
}

export function resourceLimit() {
  return MAX_BYTES;
}
