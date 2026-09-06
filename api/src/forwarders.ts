import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.ts";
import {
  compose,
  composePs,
  dockerUpdateRestart,
  type ComposePs,
} from "./docker.ts";
import {
  readOverlay,
  recordFromService,
  serviceTemplate,
  writeOverlay,
  type ForwarderRecord,
} from "./overlay.ts";
import { readStats, statsFile } from "./stats.ts";

const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(1).max(256);
const idSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "id must be a lowercase slug (max 32)");

export const createSchema = z.object({
  id: idSchema.optional(),
  laposteUser: emailSchema,
  gmailUser: emailSchema,
  lapostePassword: passwordSchema,
  gmailPassword: passwordSchema,
  deleteAfterForward: z.boolean().optional().default(false),
});

const optionalSecret = z
  .string()
  .max(256)
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : undefined;
  });

export const patchSchema = z.object({
  gmailUser: emailSchema.optional(),
  lapostePassword: optionalSecret,
  gmailPassword: optionalSecret,
  deleteAfterForward: z.boolean().optional(),
});

export type ForwarderStatus = "running" | "stopped" | "unhealthy" | "missing";

export type ForwarderView = ForwarderRecord & {
  status: ForwarderStatus;
  lastExecAt: string | null;
  lastRunTransferred: number | null;
  lastRunOk: boolean | null;
  transferredLast24h: number;
  hasLaposteSecret: boolean;
  hasGmailSecret: boolean;
};

const PLATFORM = new Set(["caddy", "api"]);

export function secretPath(id: string, kind: "laposte" | "gmail"): string {
  return join(config.secretsDir, `${id}_${kind}.txt`);
}

function writeSecret(id: string, kind: "laposte" | "gmail", value: string): void {
  mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.secretsDir, 0o700);
  } catch {
    /* directory may not support chmod on some fs */
  }
  const firstLine = value.replace(/\r?\n/g, "").trim();
  const path = secretPath(id, kind);
  writeFileSync(path, `${firstLine}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
}

function removeSecret(id: string, kind: "laposte" | "gmail"): void {
  const path = secretPath(id, kind);
  if (existsSync(path)) unlinkSync(path);
}

function statusOf(id: string, rows: ComposePs[]): ForwarderStatus {
  const row = rows.find((r) => r.service === id);
  if (!row) return "missing";
  const running = row.state === "running";
  if (running && row.health === "unhealthy") return "unhealthy";
  if (running) return "running";
  return "stopped";
}

export function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  let slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = `fwd-${slug}`.replace(/-+$/g, "");
  }
  slug = slug.slice(0, 32).replace(/-+$/g, "");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug)) {
    throw new Error("could not derive a valid id from the La Poste address");
  }
  return slug;
}

function uniqueId(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted) && !config.reservedIds.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const base = wanted.slice(0, 32 - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate) && !config.reservedIds.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique id");
}

export async function listForwarders(): Promise<ForwarderView[]> {
  const overlay = readOverlay();
  let rows: ComposePs[] = [];
  try {
    rows = (await composePs()).filter((r) => !PLATFORM.has(r.service));
  } catch {
    rows = [];
  }
  return Object.keys(overlay.services)
    .sort()
    .map((id) => toView(id, overlay.services[id]!, rows));
}

function toView(
  id: string,
  svc: NonNullable<ReturnType<typeof readOverlay>["services"][string]>,
  rows: ComposePs[],
): ForwarderView {
  const rec = recordFromService(id, svc);
  const stats = readStats(id);
  return {
    ...rec,
    status: statusOf(id, rows),
    lastExecAt: stats.lastExecAt,
    lastRunTransferred: stats.lastRunTransferred,
    lastRunOk: stats.lastRunOk,
    transferredLast24h: stats.transferredLast24h,
    hasLaposteSecret: existsSync(secretPath(id, "laposte")),
    hasGmailSecret: existsSync(secretPath(id, "gmail")),
  };
}

export function getForwarder(id: string): ForwarderRecord | null {
  const overlay = readOverlay();
  const svc = overlay.services[id];
  if (!svc) return null;
  return recordFromService(id, svc);
}

export async function createForwarder(input: z.infer<typeof createSchema>): Promise<ForwarderView> {
  const overlay = readOverlay();
  const taken = new Set(Object.keys(overlay.services));
  const wanted = input.id ?? slugFromEmail(input.laposteUser);
  if (input.id && (taken.has(input.id) || config.reservedIds.has(input.id))) {
    throw Object.assign(new Error("id is already in use"), { status: 409 });
  }
  const id = input.id ?? uniqueId(wanted, taken);
  writeSecret(id, "laposte", input.lapostePassword);
  writeSecret(id, "gmail", input.gmailPassword);
  overlay.services[id] = serviceTemplate({
    id,
    laposteUser: input.laposteUser,
    gmailUser: input.gmailUser,
    deleteAfterForward: input.deleteAfterForward,
    restart: "unless-stopped",
  });
  writeOverlay(overlay);
  try {
    await compose(["up", "-d", "--no-deps", id], 120_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : "compose up failed";
    throw Object.assign(new Error(message), { status: 502 });
  }
  const listed = await listForwarders();
  return listed.find((f) => f.id === id)!;
}

export async function patchForwarder(
  id: string,
  input: z.infer<typeof patchSchema>,
): Promise<ForwarderView> {
  const overlay = readOverlay();
  const svc = overlay.services[id];
  if (!svc) {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
  const rec = recordFromService(id, svc);
  let recreate = false;
  if (input.gmailUser && input.gmailUser !== rec.gmailUser) {
    svc.environment.GMAIL_USER = input.gmailUser;
    recreate = true;
  }
  if (typeof input.deleteAfterForward === "boolean") {
    svc.environment.DELETE_AFTER_FORWARD = input.deleteAfterForward ? "true" : "false";
    recreate = true;
  }
  if (input.lapostePassword) {
    writeSecret(id, "laposte", input.lapostePassword);
    recreate = true;
  }
  if (input.gmailPassword) {
    writeSecret(id, "gmail", input.gmailPassword);
    recreate = true;
  }
  overlay.services[id] = svc;
  writeOverlay(overlay);
  if (recreate) {
    try {
      await compose(["up", "-d", "--no-deps", "--force-recreate", id], 120_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "compose recreate failed";
      throw Object.assign(new Error(message), { status: 502 });
    }
  }
  const listed = await listForwarders();
  const view = listed.find((f) => f.id === id);
  if (!view) throw Object.assign(new Error("not found"), { status: 404 });
  return view;
}

export async function startForwarder(id: string): Promise<ForwarderView> {
  const overlay = readOverlay();
  const svc = overlay.services[id];
  if (!svc) throw Object.assign(new Error("not found"), { status: 404 });
  svc.restart = "unless-stopped";
  overlay.services[id] = svc;
  writeOverlay(overlay);
  try {
    const rows = await composePs();
    const existing = rows.find((r) => r.service === id);
    if (!existing) {
      await compose(["up", "-d", "--no-deps", id], 120_000);
    } else {
      try {
        await dockerUpdateRestart(svc.container_name, "unless-stopped");
      } catch {
        /* container name may not exist yet */
      }
      await compose(["start", id], 60_000);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "start failed";
    throw Object.assign(new Error(message), { status: 502 });
  }
  const listed = await listForwarders();
  return listed.find((f) => f.id === id)!;
}

export async function stopForwarder(id: string): Promise<ForwarderView> {
  const overlay = readOverlay();
  const svc = overlay.services[id];
  if (!svc) throw Object.assign(new Error("not found"), { status: 404 });
  svc.restart = "no";
  overlay.services[id] = svc;
  writeOverlay(overlay);
  try {
    try {
      await dockerUpdateRestart(svc.container_name, "no");
    } catch {
      /* ignore if the container is already gone */
    }
    await compose(["stop", id], 60_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : "stop failed";
    throw Object.assign(new Error(message), { status: 502 });
  }
  const listed = await listForwarders();
  return listed.find((f) => f.id === id)!;
}

export async function deleteForwarder(id: string): Promise<void> {
  const overlay = readOverlay();
  if (!overlay.services[id]) {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
  try {
    await compose(["rm", "-sf", id], 60_000);
  } catch {
    /* container may already be absent */
  }
  delete overlay.services[id];
  writeOverlay(overlay);
  removeSecret(id, "laposte");
  removeSecret(id, "gmail");
  const stats = statsFile(id);
  if (existsSync(stats)) unlinkSync(stats);
}
