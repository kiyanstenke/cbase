// Notifications: vocabulary and calls for the UI.
// The truth lives in the server (server/backend/electron/server/notify.js); here are only the types and the calls. The labels come WITH
// the response so they exist only once: they also appear on the lock screen, and two sources would drift apart.
import { api } from "@/lib/api";

export type NotifyValue = "on" | "off";
export type NotifyChoice = Record<string, NotifyValue>;

export type NotifyKind = {
  key: string;
  chat: boolean;
  preset: boolean;
  value: boolean;
  label: string;
  hint: string;
};

export type NotifyDoc = {
  kinds: NotifyKind[];
  chatKinds: string[];
  scheduleKinds: string[];
};

export type PushDevice = {
  installationId: string;
  environment: string;
  locale: string;
  createdAt: number;
  lastSeen: number;
  lastStatus: number;
  lastReason: string;
  lastPushAt: number;
};

export type PushInfo = {
  topic: string;
  sandbox: boolean;
  production: boolean;
  deviceCount: number;
  devices: PushDevice[];
};

export const loadNotify = () => api<NotifyDoc>("/api/notify");
export const saveNotify = (values: Record<string, boolean>) =>
  api<{ ok: boolean; values: Record<string, boolean> }>("/api/notify", { method: "PUT", body: JSON.stringify(values) });

// The gateway holds the devices; the backend container must never see the APNs key.
// Without a gateway (local operation) there is none; the section then stays empty.
export async function loadPushDevices(): Promise<PushInfo | null> {
  try {
    const r = await fetch("/gw/push", { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as PushInfo;
  } catch { return null; }
}

export async function testPush(): Promise<{ devices: { environment: string; status: number; reason: string; ok: boolean }[]; reason?: string } | null> {
  try {
    const r = await fetch("/gw/push/test", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "cbase", subtitle: "Test" }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// "standard" is NOT stored; it is the absence of an entry. The UI still works with three positions, so exactly this function
// translates back and forth.
export const position = (choice: NotifyChoice | undefined, kind: string): "standard" | NotifyValue =>
  choice?.[kind] === "on" ? "on" : choice?.[kind] === "off" ? "off" : "standard";

export function setPosition(choice: NotifyChoice, kind: string, value: "standard" | NotifyValue): NotifyChoice {
  const next = { ...choice };
  if (value === "standard") delete next[kind];
  else next[kind] = value;
  return next;
}

// How the chat list shows that a chat deviates from the default. "off" wins in a mixed state: silence is the state that
// surprises.
export function chatMarker(choice: NotifyChoice | undefined): "" | "silent" | "loud" {
  const values = Object.values(choice || {});
  if (values.includes("off")) return "silent";
  if (values.includes("on")) return "loud";
  return "";
}
