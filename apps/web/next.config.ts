import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Produces a self-contained server bundle so the runtime image carries no
  // node_modules and no build toolchain.
  output: 'standalone',
  // In a pnpm workspace the real dependencies live in the ROOT node_modules,
  // reached through symlinks. Without pinning the tracing root, Next traces
  // from apps/web and the standalone bundle ships without them — the image
  // builds fine and then dies at runtime on "Cannot find module".
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // `pg` is a native-ish driver; bundling it into the server build breaks it.
  serverExternalPackages: ['pg'],
  eslint: { ignoreDuringBuilds: true },
};

export default config;
