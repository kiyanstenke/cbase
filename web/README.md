# `web/` — the shared UI

The one source of the cbase interface: a Next.js app built as a static export (`npm run build` → `out/`). The gateway serves it to
browsers and the desktop client; a bare backend serves it in tests and local development. Only the edges (connection, login,
account, environment status) differ between those hosts.

```
npm ci
npm run dev        # development server
npm run build      # static export into out/
npx tsc --noEmit -p .   # the fast type check
```

| Path | What |
|---|---|
| `src/app/` | the pages |
| `src/components/` | the components, by area (map: [src/components/README.md](src/components/README.md)) |
| `src/lib/` | API facade (`api.ts` over `api/*.ts`), state, translations (`i18n-*.ts`), shared contracts |
| `public/` | static files, including `THIRD_PARTY_NOTICES.txt` (generated from `src/lib/thirdParty.ts`) |
| `test/` | the web suite (`node --test`), stream fixtures and recorders (see `test/streams/README.md`) |

The UI language is English; German comes from `src/lib/i18n-de.ts`. A new UI string needs its translation there.
