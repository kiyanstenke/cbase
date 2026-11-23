# Third-party marks in cbase

cbase shows a few logos of services it connects to, only to name that service next to the feature that talks to it. Every mark
below belongs to its owner. cbase is not affiliated with, sponsored or endorsed by any of them, and the GNU AGPL of this
repository grants no right to use any of these marks (AGPL-3.0, section 7 e; see `NOTICE`). Copyright notices for the drawings
themselves (Simple Icons, CC0) are in `web/public/THIRD_PARTY_NOTICES.txt`, generated from `web/src/lib/thirdParty.ts`.

If you fork cbase and ship it, check each owner's terms yourself: permission to use a mark is usually given to a person or
company and does not pass to you through this repository.

## Marks that ship

| Mark | Owner | Where | Source of the drawing | Terms |
|---|---|---|---|---|
| GitLab (tanuki, single colour) | GitLab Inc. | `mobile/CbaseMobile/Assets.xcassets/IntegrationGitLab.imageset/gitlab.svg`, `web/src/components/settings/IntegrationsSettings.tsx` (`GitlabLogo`) | Simple Icons 16.38.0, `icons/gitlab.svg`, unchanged | [GitLab trademark guidelines](https://handbook.gitlab.com/handbook/marketing/brand-and-product-marketing/brand/brand-activation/trademark-guidelines/) |
| ngrok (wordmark) | ngrok Inc. | `mobile/CbaseMobile/Assets.xcassets/IntegrationNgrok.imageset/ngrok.svg`, `web/src/components/settings/IntegrationsSettings.tsx` (`NgrokLogo`) | Simple Icons 16.38.0, `icons/ngrok.svg`, unchanged (viewBox cropped to the wordmark in both copies) | owner's terms, no published guideline found |
| Logos of MCP servers (Notion, Linear, Asana, Atlassian, Sentry, Stripe, Intercom, PayPal, Square, Cloudflare, Webflow, Zapier, HubSpot, Vercel, Neon, Supabase, Prisma, Wix, GitHub, Git, PostgreSQL, SQLite, Brave, Puppeteer, GitLab, Google Maps) | their respective owners | `web/src/components/brandLogos.ts` (shown by `web/src/components/McpIcon.tsx`) | Simple Icons 16.38.0, unchanged | each owner's terms |

## Marks that do not ship

The providers cbase runs on are shown with neutral glyphs, not with company logos (`web/src/components/ProviderMarks.tsx`, iOS
assets `ProviderClaude` and `ProviderCodex`):

- **Anthropic / Claude.** Anthropic's trademark guidelines allow use only with prior approval and forbid any alteration (colour,
  proportion). The mark cbase used to carry was recoloured. Replaced by a speech bubble.
- **OpenAI / Codex / ChatGPT.** The blossom cbase used to carry was the pre-2025 drawing from Simple Icons (up to 15.22.0).
  Simple Icons removed it in 16.0.0 because OpenAI's permission to use its marks is not transferable, so a public repository
  cannot pass it on. Replaced by code brackets.
- **OpenRouter.** Never shipped; cbase draws its own route glyph.

The provider names (Claude, Claude Code, Codex, ChatGPT, OpenRouter) appear as text where a feature needs to name the service.

MCP servers whose logo is not in Simple Icons are shown with a neutral initial on the app tile, in ink, not in the brand's colours
(`web/src/components/McpIcon.tsx`):

- **Playwright, Slack, Canva, monday.com.** cbase used to carry hand-drawn versions of these logos. A redrawn mark is a modified
  mark, and none of the four is in Simple Icons 16.38.0, so there is no unchanged drawing to ship. Replaced by the letters P, S, C
  and M. GitLab and Google Maps, also hand-drawn before, now use the unchanged Simple Icons drawing (see above). The guard
  `web/test/trademarks.test.mjs` keeps the old drawings out.

The cbase name and lens logo are the author's own work and are likewise not licensed as marks (see `NOTICE`).
