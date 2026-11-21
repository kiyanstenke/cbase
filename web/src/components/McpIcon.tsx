"use client";

import type { ReactNode } from "react";
import { BRAND_LOGOS } from "@/components/brandLogos";

// Icons for MCP servers. Known services get their brand logo exactly as Simple Icons ships it
// (path and brand colour unchanged, on a neutral app tile); a known service without a Simple
// Icons logo gets a neutral initial in ink, never a redrawn mark (a redrawn trademark is a
// modified one, see TRADEMARKS.md and the guard web/test/trademarks.test.mjs); anything unknown
// gets a generic MCP plug symbol. Purely for identification in the list.

function iconKey(raw: string): string {
  const n = (raw || "").toLowerCase();
  if (n.includes("cbase")) return "cbase";
  if (n.includes("playwright")) return "playwright";
  if (n.includes("puppeteer")) return "puppeteer";
  if (n.includes("github")) return "github"; // also covers "github-remote"
  if (n.includes("gitlab")) return "gitlab";
  if (n.includes("notion")) return "notion";
  if (n.includes("linear")) return "linear";
  if (n.includes("asana")) return "asana";
  if (n.includes("atlassian") || n.includes("jira") || n.includes("confluence")) return "atlassian";
  if (n.includes("sentry")) return "sentry";
  if (n.includes("stripe")) return "stripe";
  if (n.includes("canva")) return "canva";
  if (n.includes("intercom")) return "intercom";
  if (n.includes("paypal")) return "paypal";
  if (n.includes("square")) return "square";
  if (n.includes("cloudflare")) return "cloudflare";
  if (n.includes("webflow")) return "webflow";
  if (n.includes("zapier")) return "zapier";
  if (n.includes("hubspot")) return "hubspot";
  if (n.includes("vercel")) return "vercel";
  if (n.includes("neon")) return "neon";
  if (n.includes("supabase")) return "supabase";
  if (n.includes("prisma")) return "prisma";
  if (n.includes("wix")) return "wix";
  if (n.includes("monday")) return "monday";
  if (n.includes("globalping")) return "globalping";
  if (n.includes("simplescraper") || n.includes("scraper")) return "simplescraper";
  if (n.includes("slack")) return "slack";
  if (n.includes("postgres") || n.includes("postgre")) return "postgres";
  if (n.includes("google") && n.includes("map")) return "gmaps";
  if (n.includes("fetch")) return "fetch";
  if (n.includes("time") || n.includes("clock")) return "time";
  if (n.includes("filesystem") || n.includes("file-system")) return "filesystem";
  if (n.includes("sequential") || n.includes("thinking")) return "sequential";
  if (n.includes("brave")) return "brave";
  if (n.includes("memory")) return "memory";
  if (n.includes("sqlite")) return "sqlite";
  if (n.includes("redis") || n.includes("mongo") || n.includes("mysql") || n.includes("database") || n.includes("db")) return "database";
  if (/(^|[^a-z])git([^a-z]|$)/.test(n)) return "git";
  return "generic";
}

// Neutral app tile; the content (in 0..24 coordinates) is scaled to logo size and centred. A
// white tile guarantees contrast for dark logos in both themes.
function Chip({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.5" fill="#ffffff" stroke="rgba(15,17,21,0.10)" strokeWidth="0.75" />
      <g transform="translate(4.7 4.7) scale(0.608)">{children}</g>
    </svg>
  );
}

// A neutral initial on the app tile: ink, no brand colour, so it reads as a label, not as a logo.
function Initial({ size, letter }: { size: number; letter: string }) {
  return (
    <Chip size={size}>
      <text x="12" y="17" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={700} fontSize="15" fill="#3f3f46">{letter}</text>
    </Chip>
  );
}

export function McpIcon({ name, size = 18 }: { name: string; size?: number }) {
  const k = iconKey(name);
  const box = { width: size, height: size, viewBox: "0 0 24 24" as const, "aria-hidden": true };

  // Official brand logos from simple-icons (real SVG paths, brand colour).
  const logo = BRAND_LOGOS[k];
  if (logo) {
    return (
      <Chip size={size}>
        <path fill={logo.hex} d={logo.path} />
      </Chip>
    );
  }

  switch (k) {
    case "cbase":
      return (
        <Chip size={size}>
          <defs>
            <linearGradient id="cbaseG" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#0c9cfc" />
              <stop offset="1" stopColor="#6c30f0" />
            </linearGradient>
          </defs>
          <polygon points="12,2.5 20.4,7.25 20.4,16.75 12,21.5 3.6,16.75 3.6,7.25" fill="url(#cbaseG)" />
          <polygon points="12,6.5 16.9,9.3 16.9,14.7 12,17.5 7.1,14.7 7.1,9.3" fill="none" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.6" />
        </Chip>
      );
    // Services whose logo is not in Simple Icons get a neutral initial instead of a redrawn mark (TRADEMARKS.md).
    case "playwright":
      return <Initial size={size} letter="P" />;
    case "slack":
      return <Initial size={size} letter="S" />;
    case "canva":
      return <Initial size={size} letter="C" />;
    case "monday":
      return <Initial size={size} letter="M" />;
    case "globalping":
      // Globe with grid lines.
      return (
        <Chip size={size}>
          <g fill="none" stroke="#17A2B8" strokeWidth="1.6">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17M12 3.5c2.8 2.4 2.8 14.6 0 17M12 3.5c-2.8 2.4-2.8 14.6 0 17" />
          </g>
        </Chip>
      );
    case "simplescraper":
      return (
        <Chip size={size}>
          <text x="12" y="17" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={700} fontSize="15" fill="#5B21B6">S</text>
        </Chip>
      );
    // ── Generic capabilities (no brand): plain glyphs without a tile ──────
    case "database":
      return (
        <svg {...box}>
          <ellipse cx="12" cy="6.2" rx="7" ry="3" fill="#5eab8b" />
          <path d="M5 6.2v11.6c0 1.66 3.13 3 7 3s7-1.34 7-3V6.2c0 1.66-3.13 3-7 3s-7-1.34-7-3z" fill="#2f9e6b" />
        </svg>
      );
    case "filesystem":
      return (
        <svg {...box}>
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" fill="#e0a93a" />
          <path d="M3 9h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" fill="#f0c15e" />
        </svg>
      );
    case "fetch":
      return (
        <svg {...box} fill="none" stroke="#2f7bd6" strokeWidth="1.6">
          <circle cx="12" cy="11" r="7.5" />
          <path d="M4.5 11h15M12 3.5c2.4 2 2.4 13 0 15M12 3.5c-2.4 2-2.4 13 0 15" />
        </svg>
      );
    case "time":
      return (
        <svg {...box} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v5l3.2 2" />
        </svg>
      );
    case "sequential":
      return (
        <svg {...box} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="6" cy="6" r="2.4" fill="var(--color-accent)" stroke="none" />
          <circle cx="18" cy="12" r="2.4" fill="var(--color-accent)" stroke="none" />
          <circle cx="6" cy="18" r="2.4" fill="var(--color-accent)" stroke="none" />
          <path d="M8.4 6h4a2 2 0 0 1 2 2v1.6M15.6 12h-4a2 2 0 0 0-2 2v1.6" />
        </svg>
      );
    case "memory":
      return (
        <svg {...box} fill="none" stroke="#8b5cf6" strokeWidth="1.7">
          <path d="M9 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 5 3.5 3.5 0 0 0 5 4V4z" fill="#8b5cf6" stroke="none" opacity="0.85" />
          <path d="M15 4a4 4 0 0 1 4 4 3.5 3.5 0 0 1 1 5 3.5 3.5 0 0 1-5 4V4z" fill="#a78bfa" stroke="none" opacity="0.85" />
        </svg>
      );
    default:
      // Generic: MCP plug/puzzle.
      return (
        <svg {...box} fill="none" stroke="var(--color-dim)" strokeWidth="1.7" strokeLinejoin="round">
          <path d="M10 4v2.5a1.5 1.5 0 0 0 3 0V4h3v4h1.5a1.5 1.5 0 0 1 0 3H16v3h-3v-1.5a1.5 1.5 0 0 0-3 0V17H7v-3H5.5a1.5 1.5 0 0 1 0-3H7V7h3z" fill="var(--color-dim)" fillOpacity="0.18" />
        </svg>
      );
  }
}
