export type ForwarderStatus = "running" | "stopped" | "unhealthy" | "missing";

export type Forwarder = {
  id: string;
  laposteUser: string;
  gmailUser: string;
  deleteAfterForward: boolean;
  status: ForwarderStatus;
  lastExecAt: string | null;
  lastRunTransferred: number | null;
  lastRunOk: boolean | null;
  transferredLast24h: number;
  hasLaposteSecret: boolean;
  hasGmailSecret: boolean;
};

export type ApiError = { error: string };
