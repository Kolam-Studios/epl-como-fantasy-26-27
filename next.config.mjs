/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` lets the NAS Docker image run without the full node_modules tree.
  // Vercel ignores this and uses its own build output. Same repo, both targets.
  output: "standalone",
  // Ship both league config files (local override only if present) with the traced serverless/standalone output so the runtime fs read in lib/config.ts finds them (top-level key in Next 15).
  outputFileTracingIncludes: {
    "/**": ["./league.config.json", "./league.config.local.json"],
  },
};

export default nextConfig;
