
// UI and API come from the same server (Electron, 127.0.0.1:7718) — relative paths suffice.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts?.body ? { "Content-Type": "application/json" } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const msg =
      (typeof data === "object" && data && ((data as Record<string, unknown>).error || (data as Record<string, unknown>).detail)) ||
      r.statusText;
    // Behind the tunnel a long request ends with 524 and an HTML page, and over HTTP/2 `statusText` is
    // empty — the error then had NO text and the UI showed an empty red line. Without text the status
    // code stands there.
    const err = new Error(String(msg ?? "").trim() || `HTTP ${r.status}`);
    // Keep structured error fields (e.g. authRequired/host for git) for callers.
    if (typeof data === "object" && data) Object.assign(err, data);
    // The status code for callers that tell it apart (524 means "the tunnel gave up, the gateway keeps
    // working" — lib/administration-procedure.ts `runningStill`). AFTER the body: a field of the same name there does not overwrite it.
    Object.assign(err, { httpStatus: r.status });
    throw err;
  }
  return data as T;
}

