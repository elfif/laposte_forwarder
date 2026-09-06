import type { Forwarder } from "./types";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  me: () => fetch("/api/me", { credentials: "include" }),

  login: (password: string) =>
    request<{ ok: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),

  list: () => request<{ forwarders: Forwarder[] }>("/api/forwarders"),

  create: (body: {
    laposteUser: string;
    gmailUser: string;
    lapostePassword: string;
    gmailPassword: string;
    deleteAfterForward: boolean;
  }) =>
    request<{ forwarder: Forwarder }>("/api/forwarders", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  patch: (
    id: string,
    body: {
      gmailUser?: string;
      lapostePassword?: string;
      gmailPassword?: string;
      deleteAfterForward?: boolean;
    },
  ) =>
    request<{ forwarder: Forwarder }>(`/api/forwarders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  start: (id: string) =>
    request<{ forwarder: Forwarder }>(
      `/api/forwarders/${encodeURIComponent(id)}/start`,
      { method: "POST" },
    ),

  stop: (id: string) =>
    request<{ forwarder: Forwarder }>(
      `/api/forwarders/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
    ),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/forwarders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

export function isUnauthorized(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401,
  );
}
