# CopilotKit + GitHub Copilot SDK

This Next.js app uses CopilotKit for the chat UI and AG-UI runtime, with the TypeScript [GitHub Copilot SDK](https://github.com/github/copilot-sdk) as its server-side agent. The browser and CopilotKit runtime share one origin. The SDK starts its bundled Copilot runtime locally unless `COPILOT_RUNTIME_URL` points at a headless runtime.

## Run locally

1. Install dependencies with `npm install` (Node.js 20.19+ or 22.12+).
2. Sign in to the Copilot CLI with a GitHub account that can use Copilot, or configure [another supported SDK authentication method](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate). Credentials stay on the server.
3. Copy `.env.example` to `.env.local`. `COPILOT_MODEL=auto` lets Copilot choose a model. For a separate headless runtime, set `COPILOT_RUNTIME_URL` to its URL and run that service first.
4. Run `npm run dev` and open <http://localhost:3000>.
5. Open the sidebar and send two messages in the same thread. In the local Inspector, check **Agents → Agent** and **Agents → AG-UI Events** for streamed text and run completion.

The adapter in `src/lib/copilot-sdk-agent.ts` resumes a Copilot SDK session using the CopilotKit thread ID. It sends only the newest user message because the SDK retains prior turns. The SDK session is disconnected after each response while its transcript remains resumable in `.copilot-sdk/` by default. Set `COPILOT_DATA_DIR` to a persistent, writable directory when deploying with the bundled runtime. The default CopilotKit runner keeps its own thread history only in process memory, so a production deployment needs a persistent runner if the UI must reload older messages after a restart.

The SDK client runs in `mode: "empty"`: this starter exposes chat without ambient filesystem, shell, MCP, or browser tools. Frontend tools, shared state, attachments, and permission prompts require explicit AG-UI mappings before use. This starter has no application user authentication, so serve it to one trusted user locally; add thread ownership checks and per-user SDK credentials before serving multiple users. See the [CopilotKit runner](https://docs.copilotkit.ai/backend/agent-runner) and [Copilot SDK multi-user](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy) guides.

Use `npm run typecheck` and `npm run build` after installing dependencies.

The CopilotKit MCP server registered with Codex supplies documentation tools to the coding agent. It is separate from this app's Copilot SDK agent. If `codex mcp list` says `Not logged in`, run `codex mcp login copilotkit` when browser access is available, then start a new Codex session and use `/mcp` to inspect the connection. Registration alone does not verify tool access.
