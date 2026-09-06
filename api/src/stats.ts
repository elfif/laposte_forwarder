import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export type StatsSummary = {
  lastExecAt: string | null;
  lastRunTransferred: number | null;
  lastRunOk: boolean | null;
  transferredLast24h: number;
};

type StatsLine = {
  ts: string;
  ok: boolean;
  transferred: number;
};

function parseLine(raw: string): StatsLine | null {
  try {
    const row = JSON.parse(raw) as Partial<StatsLine>;
    if (typeof row.ts !== "string") return null;
    const transferred = Number(row.transferred);
    if (!Number.isFinite(transferred) || transferred < 0) return null;
    return {
      ts: row.ts,
      ok: row.ok === true,
      transferred,
    };
  } catch {
    return null;
  }
}

export function readStats(id: string): StatsSummary {
  const empty: StatsSummary = {
    lastExecAt: null,
    lastRunTransferred: null,
    lastRunOk: null,
    transferredLast24h: 0,
  };
  const file = join(config.statsDir, `${id}.jsonl`);
  if (!existsSync(file)) return empty;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return empty;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let transferredLast24h = 0;
  let last: StatsLine | null = null;
  for (const line of lines) {
    const row = parseLine(line);
    if (!row) continue;
    last = row;
    const t = Date.parse(row.ts);
    if (Number.isFinite(t) && t >= cutoff) {
      transferredLast24h += row.transferred;
    }
  }
  if (!last) return empty;
  return {
    lastExecAt: last.ts,
    lastRunTransferred: last.transferred,
    lastRunOk: last.ok,
    transferredLast24h,
  };
}

export function statsFile(id: string): string {
  return join(config.statsDir, `${id}.jsonl`);
}
