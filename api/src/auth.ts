import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "./config.ts";

const COOKIE = "fwd_session";

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verifyPassword(password: string): boolean {
  return safeEqual(password, config.uiPassword);
}

export function issueSession(): string {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const payload = String(exp);
  return `${payload}.${sign(payload)}`;
}

export function sessionValid(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(sign(payload), mac)) return false;
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return true;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Strict",
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function readSession(c: Context): string | undefined {
  return getCookie(c, COOKIE);
}

const loginHits = new Map<string, number[]>();

export function allowLoginAttempt(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const recent = (loginHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= 5) {
    loginHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginHits.set(ip, recent);
  return true;
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return c.req.header("x-real-ip") || "unknown";
}

export async function requireSession(c: Context, next: Next) {
  if (!sessionValid(readSession(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
