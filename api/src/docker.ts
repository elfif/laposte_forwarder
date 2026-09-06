import { spawn } from "node:child_process";
import { config } from "./config.ts";

export type ComposePs = {
  service: string;
  state: string;
  health: string;
  name: string;
};

function run(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.COMPOSE_FILE;
    const child = spawn("docker", args, {
      cwd: config.projectDir,
      env: { ...env, COMPOSE_PROJECT_NAME: config.projectName },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`docker command timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function composeArgs(extra: string[]): string[] {
  return [
    "compose",
    "--project-directory",
    config.projectDir,
    "-f",
    config.composeFile,
    "-f",
    config.overlayPath,
    ...extra,
  ];
}

export async function compose(
  extra: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  const result = await run(composeArgs(extra), timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new Error(detail);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function composePs(): Promise<ComposePs[]> {
  const { stdout } = await compose(["ps", "-a", "--format", "json"]);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // Compose prints either a JSON array or one object per line, depending on version.
  if (trimmed.startsWith("[")) {
    const rows = JSON.parse(trimmed) as Record<string, string>[];
    return rows.map(normalizePs);
  }
  return trimmed
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizePs(JSON.parse(line) as Record<string, string>));
}

function normalizePs(row: Record<string, string>): ComposePs {
  return {
    service: row.Service ?? row.service ?? "",
    state: (row.State ?? row.state ?? "").toLowerCase(),
    health: (row.Health ?? row.health ?? "").toLowerCase(),
    name: row.Name ?? row.name ?? "",
  };
}

export async function dockerUpdateRestart(
  containerName: string,
  policy: "unless-stopped" | "no",
): Promise<void> {
  const result = await run(["update", "--restart", policy, containerName]);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || "docker update failed");
  }
}
