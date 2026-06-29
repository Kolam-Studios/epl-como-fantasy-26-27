/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` lets the NAS Docker image run without the full node_modules tree.
  // Vercel ignores this and uses its own build output. Same repo, both targets.
  output: "standalone",
};

export default nextConfig;
