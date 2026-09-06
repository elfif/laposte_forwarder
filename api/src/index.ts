import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  allowLoginAttempt,
  clearSessionCookie,
  clientIp,
  issueSession,
  requireSession,
  sessionValid,
  setSessionCookie,
  readSession,
  verifyPassword,
} from "./auth.ts";
import { config } from "./config.ts";
import {
  createForwarder,
  createSchema,
  deleteForwarder,
  listForwarders,
  patchForwarder,
  patchSchema,
  startForwarder,
  stopForwarder,
} from "./forwarders.ts";
import { existsSync } from "node:fs";
import { emptyOverlay, writeOverlay } from "./overlay.ts";

if (!existsSync(config.overlayPath)) {
  writeOverlay(emptyOverlay());
}

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/login", async (c) => {
  const ip = clientIp(c);
  if (!allowLoginAttempt(ip)) {
    return c.json({ error: "too many attempts" }, 429);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = z.object({ password: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "password is required" }, 400);
  }
  if (!verifyPassword(parsed.data.password)) {
    return c.json({ error: "invalid password" }, 401);
  }
  setSessionCookie(c, issueSession());
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  if (!sessionValid(readSession(c))) {
    return c.json({ ok: false }, 401);
  }
  return c.json({ ok: true });
});

app.use("/api/forwarders/*", requireSession);
app.use("/api/forwarders", requireSession);

app.get("/api/forwarders", async (c) => {
  const forwarders = await listForwarders();
  return c.json({ forwarders });
});

app.post("/api/forwarders", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
  }
  const forwarder = await createForwarder(parsed.data);
  return c.json({ forwarder }, 201);
});

app.patch("/api/forwarders/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
  }
  if (
    parsed.data.gmailUser === undefined &&
    parsed.data.lapostePassword === undefined &&
    parsed.data.gmailPassword === undefined &&
    parsed.data.deleteAfterForward === undefined
  ) {
    return c.json({ error: "no fields to update" }, 400);
  }
  const forwarder = await patchForwarder(id, parsed.data);
  return c.json({ forwarder });
});

app.post("/api/forwarders/:id/start", async (c) => {
  const forwarder = await startForwarder(c.req.param("id"));
  return c.json({ forwarder });
});

app.post("/api/forwarders/:id/stop", async (c) => {
  const forwarder = await stopForwarder(c.req.param("id"));
  return c.json({ forwarder });
});

app.delete("/api/forwarders/:id", async (c) => {
  await deleteForwarder(c.req.param("id"));
  return c.json({ ok: true });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  const status = (err as { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : "internal error";
  if (status >= 500) {
    console.error("[api]", message);
  }
  const code = status === 400 || status === 404 || status === 409 || status === 502 ? status : status >= 500 ? 500 : 400;
  return c.json({ error: status >= 500 ? "internal error" : message }, code);
});

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[api] listening on ${info.address}:${info.port}`);
});
