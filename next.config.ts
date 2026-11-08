/**
 * @file Next.js server build configuration.
 * @description Loads the Copilot SDK through Node.js instead of bundling its native addon.
 * @remarks This setting applies to server routes; browser bundles must never import the SDK.
 */
import type { NextConfig } from "next";

/** The Copilot SDK loads Koffi's platform-specific .node file at runtime. */
const nextConfig: NextConfig = {
  serverExternalPackages: ["@github/copilot-sdk"],
};

export default nextConfig;
