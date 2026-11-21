// Fixture routes: /fixture/settings, /fixture/gitlab, browser (endsWith(/browser/ensure)), terminal (endsWith(/terminal)).
import { readFileSync } from "node:fs";
import { dataRow, catchUpTerminal } from "../../../server/backend/electron/server/terminal-stream.js";
import { S, json, autoContinueList, CREDIT_GATE_THRESHOLD, resetSettings, body, terminalState, terminalId, terminalWrite, browserId, browserState, browserFrame, SERVICES_AGENT_BROWSER, NEXT } from "./state.mjs";

/** A new subscription: the first row like the server (`catchUpTerminal` from the resume point, otherwise the whole buffer).
 *  The greeting is written ONCE, at the first subscription of an empty buffer (like a prompt) — appending a new one per
 *  subscription to ALL readers is what the server no longer does. */
function terminalSubscribe(res, start) {
  const { d, until, replaced } = catchUpTerminal(terminalState, start);
  terminalState.streams.add(res);
  res.write(dataRow(d, until, replaced));
}

/** A new terminal (`POST …/terminal`): empty buffer, counter from zero — the fixture has only ONE id. */
function terminalNew() {
  terminalState.buffer = "";
  terminalState.end = 0;
}

export async function routesDevtools(ctx) {
  const { req, res, url, path, method } = ctx;
    // ── Settings: read out and reset (tests only) ─────────
    // Tests must see what REALLY arrived at the server: the switch value in the view is set
    // optimistically and does not prove delivery. Secrets appear here only as `hasKey`/`hasToken`
    // — a read-out path that gave them away would be a second door past the very promise the
    // view is meant to check.
    if (path === "/fixture/settings" && method === "GET") {
      return json(res, 200, {
        tts: { hasKey: Boolean(S.ttsConfig.apiKey), voiceId: S.ttsConfig.voiceId, modelId: S.ttsConfig.modelId, baseUrl: S.ttsConfig.baseUrl },
        webSearch: { provider: S.webSearch.provider, baseUrl: S.webSearch.baseUrl, hasKey: Boolean(S.webSearch.apiKey) },
        permissionRules: S.permissionRules.slice(),
        autoContinue: { enabled: S.autoContinueEnabled, waiting: autoContinueList().length },
        // The gate switch is set optimistically like any other — only here is what really arrived
        // at the server. `lastAttemptAnyway`: whether the last `POST …/auto-continue/now` carried
        // the one-time override (`null` = no attempt since the seed).
        creditGate: { enabled: S.creditGate, threshold: CREDIT_GATE_THRESHOLD, lastAttemptAnyway: S.limitAttemptAnyway },
        // `revoke` sits next to it so a test can also see the revocation that was set —
        // the token itself does not leave here either, only the account id.
        gitlab: {
          accounts: S.gitlabAccounts.map((a) => ({ ...a })),
          tests: S.gitlabTests,
          revoke: [...S.gitlabRevoked],
        },
        // OpenRouter: the key itself does not leave here — only whether one is set, and the last PUT body without it
        // (`apiKey: true` = was sent).
        openrouter: {
          keySet: Boolean(S.openrouter.key),
          onlyWithoutSaving: S.openrouter.onlyWithoutSaving,
          noDataUsage: S.openrouter.noDataUsage,
          lastPut: S.openrouter.lastPut,
        },
        defaultModel: { ...S.defaultModel },
        hooks: S.agentHooks.map((h) => ({ ...h })),
      });
    }
    if (path === "/fixture/settings" && method === "POST") {
      resetSettings();
      return json(res, 200, { ok: true });
    }
    // The order of the settings list as the desktop client keeps it — for
    // `SettingsUITests.testSettingsMirrorsAllDesktopSections`. Read on EVERY request from
    // `web/src/components/settings/SettingsModal.tsx`, the same source against which
    // `web/test/settings-form.test.mjs` binds the source text of `SettingsView.swift`; the
    // UI test binds what is SHOWN to it. Via the fixture and not in the test runner itself: the
    // runner lives in the simulator, where `open()` on a file under ~/Documents hung for
    // minutes — the fixture runs from the shell and reads the working tree without a prompt. An
    // anchor that hits nothing is a 500 with plain text, not an empty list: against an empty
    // expectation every test would be green.
    if (path === "/fixture/settings-ordering" && method === "GET") {
      try {
        return json(res, 200, { groups: settingsOrdering() });
      } catch (error) {
        return json(res, 500, { error: String(error?.message || error) });
      }
    }
    // An account's token is revoked in GitLab (or accepted again). This is not a route of the real
    // server but a handle on the simulated GITLAB behind it — and the only way to reach the error
    // branch of `POST …/test`: through the app itself no bad token gets into the store, because
    // creating it checks it first. Call:
    // `POST /fixture/gitlab { "id": "<accountId>", "valid": false }`.
    if (path === "/fixture/gitlab" && method === "POST") {
      const b = await body(req);
      const id = String(b.id || "");
      if (!S.gitlabAccounts.some((a) => a.id === id)) return json(res, 404, { error: "Account not found" });
      if (b.valid === false) S.gitlabRevoked.add(id); else S.gitlabRevoked.delete(id);
      return json(res, 200, { ok: true, id, valid: !S.gitlabRevoked.has(id) });
    }
    // With `/fixture/services { on: true }` an agent drives a browser — the "Agent browser"
    // section in the header's services menu. Otherwise empty.
    if (path === "/api/browsers" && method === "GET") return json(res, 200, { browsers: S.services ? [SERVICES_AGENT_BROWSER] : [] });
    // ── Terminal-Pane ──
    if (path.endsWith("/terminal") && method === "POST") {
      const request = await body(req);
      terminalState.cols = Number(request.cols) || 0;
      terminalState.rows = Number(request.rows) || 0;
      terminalNew();
      return json(res, 200, { id: terminalId, available: true });
    }
    if (path === `/api/terminal/${terminalId}/exists` && method === "GET") {
      return json(res, 200, { exists: true });
    }
    if (path === "/fixture/terminal" && method === "GET") {
      return json(res, 200, { cols: terminalState.cols, rows: terminalState.rows, input: terminalState.input });
    }
    if (path === `/api/terminal/${terminalId}/stream` && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Like the server (devtools/routes.js): the header comes first, `?from=` is iOS's path; the first row sets the state.
      terminalSubscribe(res, req.headers["last-event-id"] ?? url.searchParams.get("from"));
      // Short greeting + one row that fills exactly the reported width — ONCE per terminal, at the first subscription.
      if (terminalState.end === 0) {
        const width = Math.max(20, terminalState.cols || 40);
        terminalWrite(`agent@fixture:~$ echo hello\r\nhello\r\n${"=".repeat(width - 1)}\r\nagent@fixture:~$ `);
      }
      req.on("close", () => terminalState.streams.delete(res));
      return;
    }
    if (path === `/api/terminal/${terminalId}/input` && method === "POST") {
      const request = await body(req);
      terminalState.input.push(request.data);
      terminalWrite(String(request.data).replace(/\r/g, "\r\n"));
      return json(res, 200, { ok: true });
    }
    if (path === `/api/terminal/${terminalId}/resize` && method === "POST") {
      const request = await body(req);
      terminalState.cols = Number(request.cols) || 0;
      terminalState.rows = Number(request.rows) || 0;
      return json(res, 200, { ok: true });
    }
    if (path === `/api/terminal/${terminalId}` && method === "DELETE") {
      return json(res, 200, { ok: true });
    }
    // ── Browser-Pane ──
    if (path.endsWith("/browser/ensure") && method === "POST") {
      return json(res, 200, { id: browserId });
    }
    if (path === "/fixture/browser" && method === "GET") {
      return json(res, 200, {
        viewport: browserState.viewport,
        inputs: browserState.inputs,
        acts: browserState.acts,
      });
    }
    if (path === "/fixture/browser" && method === "DELETE") {
      browserState.inputs = [];
      browserState.acts = [];
      // Forget the reported window size too: the app does NOT send the same size again
      // (otherwise the screencast restarts needlessly) — a test waiting for the next value
      // would otherwise see the previous run's state.
      browserState.viewport = { width: 0, height: 0, dpr: 0 };
      return json(res, 200, { ok: true });
    }
    if (path === `/api/browsers/${browserId}/stream` && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({
        kind: "user",
        label: "",
        vid: "fixture-viewer",
        tab: "tab-1",
        tabs: [{ id: "tab-1", title: "Fixture-Seite", url: "https://fixture.test/", active: true }],
      })}\n\n`);
      browserState.viewers.add(res);
      browserFrame();
      const beat = setInterval(browserFrame, 700);
      S.timers.push(beat);
      req.on("close", () => {
        clearInterval(beat);
        browserState.viewers.delete(res);
      });
      return;
    }
    if (path === `/api/browsers/${browserId}/input` && method === "POST") {
      const request = await body(req);
      for (const item of request.events || []) browserState.inputs.push(item);
      return json(res, 200, { ok: true });
    }
    if (path === `/api/browsers/${browserId}/act` && method === "POST") {
      const request = await body(req);
      browserState.acts.push(request);
      if (request.type === "resize") {
        browserState.viewport = {
          width: Number(request.width) || 0,
          height: Number(request.height) || 0,
          dpr: Number(request.dpr) || 0,
        };
        browserFrame();
      }
      return json(res, 200, { ok: true, tab: "tab-1" });
    }
    if (path === `/api/browsers/${browserId}` && method === "DELETE") {
      return json(res, 200, { ok: true });
    }
    return NEXT;
}

// ── The settings order, from the desktop client's source ──────────────────────
//
// Same anchors as the web groups in `web/test/settings-form.test.mjs` — there the guard binds the
// SOURCE TEXT of both clients, here the UI test fetches the expectation for what is SHOWN.
// Every anchor throws when it hits nothing, and each counts what it skipped: a regex measures
// the spelling it knows, and the silent form of its failure is a shorter list. Comments are
// dropped first (`SECTIONS` holds one).
const SETTINGS_SOURCE = new URL("../../../web/src/components/settings/SettingsModal.tsx", import.meta.url);

function settingsOrdering() {
  const text = readFileSync(SETTINGS_SOURCE, "utf8");
  const rowsOf = (pattern, declaration) => {
    const m = text.match(pattern);
    if (!m) {
      throw new Error(
        `Declaration "${declaration}" not found in web/src/components/settings/SettingsModal.tsx — ` +
          "rebuilt or reformatted? Update the anchor here AND in web/test/settings-form.test.mjs",
      );
    }
    return m[1].split("\n").filter((z) => z.trim() && !/^\s*\/\//.test(z));
  };

  const sRows = rowsOf(/const SECTIONS: Section\[\] = \[\n([\s\S]*?)\n\];/, "const SECTIONS: Section[]");
  const labels = new Map();
  for (const z of sRows) {
    const m = z.match(/\{ key: "([^"]+)", label: "([^"]+)"/);
    if (m) labels.set(m[1], m[2]);
  }
  const sCandidates = sRows.filter((z) => /\bkey\s*:/.test(z)).length;
  if (sCandidates !== labels.size) {
    throw new Error(`SECTIONS: ${sCandidates} rows look like a page, ${labels.size} were read`);
  }

  const gRows = rowsOf(
    /export const SETTINGS_GROUPS: \{ title: string; keys: string\[\] \}\[\] = \[\n([\s\S]*?)\n\];/,
    "export const SETTINGS_GROUPS",
  );
  const groups = [];
  for (const z of gRows) {
    const m = z.match(/\{ title: "([^"]+)", keys: \[([^\]]*)\] \}/);
    if (!m) continue;
    const pages = [...m[2].matchAll(/"([^"]+)"/g)].map((k) => {
      if (!labels.has(k[1])) throw new Error(`SETTINGS_GROUPS names "${k[1]}", SECTIONS does not know the key`);
      return labels.get(k[1]);
    });
    groups.push({ title: m[1], pages });
  }
  const gCandidates = gRows.filter((z) => /\btitle\s*:/.test(z)).length;
  if (gCandidates !== groups.length) {
    throw new Error(`SETTINGS_GROUPS: ${gCandidates} rows look like a group, ${groups.length} were read`);
  }
  const count = groups.reduce((n, g) => n + g.pages.length, 0);
  if (!groups.length || count !== labels.size) {
    throw new Error(
      `SETTINGS_GROUPS lists ${count} pages in ${groups.length} groups, SECTIONS ${labels.size} — ` +
        "a page without a group would be unreachable in the desktop client",
    );
  }
  return groups;
}
