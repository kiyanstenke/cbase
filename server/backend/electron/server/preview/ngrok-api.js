// The ngrok API for reserved names (preview links, mode `names`). A leaf with `fetch` and without server imports.
//
// {API} = CBASE_NGROK_API, else https://api.ngrok.com — read at RUNTIME so a test can point to a fake server.
// Every failure is an Error with `status` (HTTP status, 0 without a response) and `code` (ERR_NGROK_…, if ngrok names
// one). OUR texts never name the API key (it is only in the request header); the `msg` taken over from ngrok CAN repeat
// it — which is why links.js redacts every error text before it reaches a response, the SSE, the access row or the log.
//
// checkApiKey(key)           GET /reserved_domains?limit=1 — throws if ngrok does not accept the key
// reserve(key, domain)       POST /reserved_domains → { id, domain }
// gibFree(key, id)           DELETE /reserved_domains/{id}; a 404 counts as released (gone is gone)
// searchReservation(key, d)  GET /reserved_domains?limit=100 → { id, domain } or null — after a reservation without a
//                            response: did it exist at ngrok after all? One page is enough: Hobbyist has at most 10 names
//                            (the follow-up link `next_page_uri` is deliberately NOT followed — it is an absolute
//                            address, and the key would go along).

const API_DEADLINE_MS = 15_000; // a hanging API would otherwise hold up creation (and the tick) forever
const api = () => String(process.env.CBASE_NGROK_API || "https://api.ngrok.com").replace(/\/+$/, "");

async function request(key, method, path, body) {
  let res;
  try {
    res = await fetch(`${api()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Ngrok-Version": "2",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_DEADLINE_MS),
    });
  } catch (e) {
    throw Object.assign(new Error(`ngrok API not reachable (${e?.name === "TimeoutError" ? `no answer within ${API_DEADLINE_MS / 1000} s` : e?.message || e})`), { status: 0, code: "" });
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

function apiError(what, r) {
  const code = typeof r.json?.error_code === "string" ? r.json.error_code : "";
  const msg = typeof r.json?.msg === "string" ? r.json.msg : r.text.slice(0, 200);
  return Object.assign(new Error(`${what}: ngrok-API ${r.status}${code ? ` ${code}` : ""}${msg ? ` — ${msg}` : ""}`), { status: r.status, code });
}

export async function checkApiKey(key) {
  const r = await request(key, "GET", "/reserved_domains?limit=1");
  if (!r.ok) throw apiError("API key rejected", r);
}

export async function reserve(key, domain) {
  const r = await request(key, "POST", "/reserved_domains", { domain, description: "cbase-Preview-Link" });
  if (!r.ok) throw apiError(`Name ${domain} not reserved`, r);
  const id = String(r.json?.id || "");
  if (!id) throw Object.assign(new Error(`Name ${domain}: ngrok API without id in the response`), { status: r.status, code: "" });
  return { id, domain: String(r.json?.domain || domain) };
}

export async function searchReservation(key, domain) {
  const r = await request(key, "GET", "/reserved_domains?limit=100");
  if (!r.ok) throw apiError(`Reservations not readable`, r);
  const list = Array.isArray(r.json?.reserved_domains) ? r.json.reserved_domains : [];
  const hits = list.find((x) => String(x?.domain || "") === domain && x?.id);
  return hits ? { id: String(hits.id), domain } : null;
}

export async function gibFree(key, id) {
  const r = await request(key, "DELETE", `/reserved_domains/${encodeURIComponent(id)}`);
  if (!r.ok && r.status !== 404) throw apiError(`Reservation ${id} not released`, r);
}
