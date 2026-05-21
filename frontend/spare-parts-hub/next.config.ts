import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // serverExternalPackages prevents Turbopack/Webpack from trying to bundle
  // AWS SDK packages — they must be treated as external (loaded from node_modules
  // at runtime, not inlined). Without this Amplify SSR throws
  // "Cannot find module '@aws-sdk/client-s3-<hash>'" at runtime.
  serverExternalPackages: [
    "@aws-sdk/client-s3",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/s3-request-presigner",
    "@aws-sdk/credential-provider-node",
    "@smithy/signature-v4",
    "@aws-crypto/sha256-js",
  ],
};

export default nextConfig;
