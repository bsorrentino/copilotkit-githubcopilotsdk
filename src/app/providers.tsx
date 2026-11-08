/**
 * @file Client-side CopilotKit context for the application.
 * @description Connects React components to the local runtime route.
 * @remarks This file does not hold model credentials; the provider lives for the page's React lifetime.
 */
"use client";

import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";

/**
 * Supplies CopilotKit context to descendants using the same-origin runtime route.
 *
 * @param children - React content that may use CopilotKit UI or hooks.
 * @returns The wrapped React subtree.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <CopilotKitProvider runtimeUrl="/api/copilotkit">{children}</CopilotKitProvider>;
}
