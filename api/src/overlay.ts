import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stringify, parse } from "yaml";
import { config } from "./config.ts";

export type ForwarderRestart = "unless-stopped" | "no";

export type OverlayService = {
  image: string;
  container_name: string;
  restart: ForwarderRestart;
  init: boolean;
  read_only: boolean;
  tmpfs: string[];
  cap_drop: string[];
  security_opt: string[];
  volumes: string[];
  command: string[];
  environment: Record<string, string>;
  secrets: string[];
  healthcheck: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
  logging: {
    driver: string;
    options: Record<string, string>;
  };
};

export type OverlayDoc = {
  services: Record<string, OverlayService>;
  secrets?: Record<string, { file: string }>;
};

export type ForwarderRecord = {
  id: string;
  laposteUser: string;
  gmailUser: string;
  deleteAfterForward: boolean;
  windowDays: string;
  intervalSeconds: string;
  healthcheckUrl: string;
  restart: ForwarderRestart;
};

const HEADER = "# Managed by the laposte-forwarder API. Do not edit by hand.\n";

export function emptyOverlay(): OverlayDoc {
  return { services: {} };
}

export function readOverlay(): OverlayDoc {
  if (!existsSync(config.overlayPath)) {
    return emptyOverlay();
  }
  const raw = readFileSync(config.overlayPath, "utf8");
  if (!raw.trim()) return emptyOverlay();
  const parsed = parse(raw) as OverlayDoc | null;
  if (!parsed || typeof parsed !== "object") return emptyOverlay();
  return {
    services: parsed.services ?? {},
    secrets: parsed.secrets,
  };
}

export function writeOverlay(doc: OverlayDoc): void {
  const services = doc.services ?? {};
  const secrets: Record<string, { file: string }> = {};
  for (const id of Object.keys(services)) {
    secrets[`${id}_laposte`] = { file: `./secrets/${id}_laposte.txt` };
    secrets[`${id}_gmail`] = { file: `./secrets/${id}_gmail.txt` };
  }
  const out: OverlayDoc = { services };
  if (Object.keys(secrets).length > 0) {
    out.secrets = secrets;
  }
  const body = stringify(out, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
  const tmp = `${config.overlayPath}.tmp`;
  writeFileSync(tmp, HEADER + body, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, config.overlayPath);
}

export function serviceTemplate(input: {
  id: string;
  laposteUser: string;
  gmailUser: string;
  deleteAfterForward: boolean;
  restart: ForwarderRestart;
  windowDays?: string;
  intervalSeconds?: string;
  healthcheckUrl?: string;
}): OverlayService {
  const id = input.id;
  return {
    image: config.imapsyncImage,
    container_name: `laposte-fwd-${id}`,
    restart: input.restart,
    init: true,
    read_only: true,
    tmpfs: ["/tmp", "/var/tmp"],
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    volumes: [
      "./bin/laposte-forward:/usr/local/bin/laposte-forward:ro",
      "./data/stats:/var/lib/laposte-forward",
    ],
    command: ["/usr/local/bin/laposte-forward", "--loop"],
    environment: {
      FORWARDER_ID: id,
      LAPOSTE_USER: input.laposteUser,
      GMAIL_USER: input.gmailUser,
      PASSFILE1: `/run/secrets/${id}_laposte`,
      PASSFILE2: `/run/secrets/${id}_gmail`,
      WINDOW_DAYS: input.windowDays ?? "1",
      INTERVAL_SECONDS: input.intervalSeconds ?? "60",
      DELETE_AFTER_FORWARD: input.deleteAfterForward ? "true" : "false",
      HEALTHCHECK_URL: input.healthcheckUrl ?? "",
      STATS_DIR: "/var/lib/laposte-forward",
    },
    secrets: [`${id}_laposte`, `${id}_gmail`],
    healthcheck: {
      test: [
        "CMD-SHELL",
        "test -f /tmp/heartbeat && test $(( $(date +%s) - $(cat /tmp/heartbeat) )) -lt 300",
      ],
      interval: "60s",
      timeout: "10s",
      retries: 3,
      start_period: "2m",
    },
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
  };
}

export function recordFromService(id: string, svc: OverlayService): ForwarderRecord {
  const env = svc.environment ?? {};
  return {
    id,
    laposteUser: env.LAPOSTE_USER ?? "",
    gmailUser: env.GMAIL_USER ?? "",
    deleteAfterForward: env.DELETE_AFTER_FORWARD === "true",
    windowDays: env.WINDOW_DAYS ?? "1",
    intervalSeconds: env.INTERVAL_SECONDS ?? "60",
    healthcheckUrl: env.HEALTHCHECK_URL ?? "",
    restart: svc.restart === "no" ? "no" : "unless-stopped",
  };
}
