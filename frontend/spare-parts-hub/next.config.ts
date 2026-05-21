import type { NextConfig } from "next";

// Amplify blocks AWS_* prefixed env vars, so we use APP_* aliases.
// This remaps them back at build/runtime so all SDK calls work unchanged.
if (process.env.APP_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID     = process.env.APP_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.APP_SECRET_ACCESS_KEY || "";
  process.env.AWS_REGION            = process.env.APP_REGION || "eu-central-1";
  process.env.AWS_S3_BUCKET         = process.env.APP_S3_BUCKET || process.env.AWS_S3_BUCKET || "";
}

const nextConfig: NextConfig = {
  // Output standalone for Amplify SSR / container deployment
  output: "standalone",
};

export default nextConfig;
