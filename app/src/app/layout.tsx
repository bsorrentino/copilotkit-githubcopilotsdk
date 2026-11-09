/**
 * @file Root layout for the Next.js app.
 * @description Loads shared styles and mounts the CopilotKit client provider.
 * @remarks This server component provides document structure; interactive state belongs in client components.
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";
import { Providers } from "./providers";

/** Browser title and description for the starter app. */
export const metadata: Metadata = {
  title: "CopilotKit + GitHub Copilot SDK",
  description: "A Next.js chat powered by CopilotKit and the GitHub Copilot SDK.",
};

/**
 * Renders the HTML shell and keeps CopilotKit available throughout the app.
 *
 * @param children - Next.js route content to render inside the provider.
 * @returns The document shell for each request.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
