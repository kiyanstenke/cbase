import type { NextConfig } from "next";

// Static export — served by the embedded server of the Electron app.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // lib/api.ts is a facade over lib/api/<part>.ts and writes its imports with a `.js` ending, because
  // web/test/global-events.test.mjs compiles the file with plain tsc and loads it as ESM in Node (no extension
  // search there). Webpack resolves `.js` to `.ts` only through this table — the same rule as moduleResolution
  // "bundler" in tsc.
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
};

export default nextConfig;
