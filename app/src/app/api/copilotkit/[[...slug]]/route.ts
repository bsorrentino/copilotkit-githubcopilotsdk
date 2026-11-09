/**
 * @file CopilotKit's Next.js runtime endpoint and Copilot SDK agent registration.
 * @description Serves CopilotKit protocol routes for the browser provider.
 * @remarks The SDK and its credentials run on Node.js; this module does not render UI or manage user accounts.
 */
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import { CopilotSdkAgent } from "copilot-sdk-agent";

/** The Copilot SDK requires a Node.js runtime for its CLI connection. */
export const runtime = "nodejs";

/** The default agent translates SDK turns into AG-UI for the existing sidebar. */
const copilotSdkAgent = new CopilotSdkAgent();

/** This single-user starter lets its anonymous caller list and clear local threads. */
const copilotRuntime = new CopilotRuntime({
  agents: { default: copilotSdkAgent },
  threads: { access: "open" },
});

/** Next.js serves this handler at the same path configured in the browser provider. */
const handler = createCopilotRuntimeHandler({ runtime: copilotRuntime, basePath: "/api/copilotkit" });

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
