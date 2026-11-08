/**
 * @file Home page for the Copilot SDK chat starter.
 * @description Presents a simple entry point and CopilotKit's sidebar chat.
 * @remarks The sidebar uses context from the root provider; this page does not call the model directly.
 */
"use client";

import { CopilotSidebar } from "@copilotkit/react-core/v2";

/** Renders the starter page and its interactive chat sidebar. */
export default function Home() {
  return (
    <main className="page">
      <div className="content">
        <p className="eyebrow">CopilotKit + Next.js</p>
        <h1>GitHub Copilot SDK chat</h1>
        <p>Open the chat sidebar and ask the agent a question.</p>
      </div>
      <CopilotSidebar />
    </main>
  );
}
