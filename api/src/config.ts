import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IMAGE =
  "gilleslamiral/imapsync:2.319@sha256:161336e1a6db587bc42ea1126cfc9b6afa67ea92b408ea4c4454f7f771561aa4";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const projectDir = required("PROJECT_DIR");

export const config = {
  projectDir,
  port: Number(process.env.PORT ?? "3000"),
  uiPassword: required("UI_PASSWORD"),
  sessionSecret: required("UI_SESSION_SECRET"),
  cookieSecure: (process.env.COOKIE_SECURE ?? "true") !== "false",
  sessionTtlSeconds: 60 * 60 * 24,
  imapsyncImage: process.env.IMAPSYNC_IMAGE?.trim() || DEFAULT_IMAGE,
  overlayPath: join(projectDir, "compose.forwarders.yaml"),
  secretsDir: join(projectDir, "secrets"),
  statsDir: join(projectDir, "data", "stats"),
  composeFile: join(projectDir, "compose.yaml"),
  projectName: "laposte_forwarder",
  reservedIds: new Set(["caddy", "api"]),
};

mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
mkdirSync(config.statsDir, { recursive: true, mode: 0o777 });
try {
  chmodSync(config.secretsDir, 0o700);
  chmodSync(config.statsDir, 0o777);
} catch {
  /* ignore chmod errors on exotic filesystems */
}
