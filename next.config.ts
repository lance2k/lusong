import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Loaded from node_modules at run time: bundling it fails on @eshaz/web-worker's dynamic import, which the decoder's
  // web-worker variant pulls in and the main-thread decoder used here never calls.
  serverExternalPackages: ["ogg-opus-decoder"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
