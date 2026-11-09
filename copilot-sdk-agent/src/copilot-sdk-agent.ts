/**
 * @file Server-side bridge from GitHub Copilot SDK sessions to AG-UI events.
 * @description Runs one Copilot SDK turn for each CopilotKit request and streams the answer.
 * @remarks The Copilot SDK owns conversation history; this module does not expose SDK credentials or tools to the browser. Sessions are disconnected after each turn and resumed by thread ID on later turns.
 */
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import { join } from "node:path";
import { Observable } from "rxjs";

/** Session transcripts and settings live in an app-owned directory unless configured otherwise. */
const dataDirectory = process.env.COPILOT_DATA_DIR || join(process.cwd(), ".copilot-sdk");

/** The SDK client shares one CLI connection across requests in this Node.js process. */
const client = new CopilotClient({
  mode: "copilot-cli",
  baseDirectory: dataDirectory,
  ...(process.env.COPILOT_RUNTIME_URL
    ? { connection: RuntimeConnection.forUri(process.env.COPILOT_RUNTIME_URL) }
    : {}),
});

/** The model selected for new sessions; "auto" delegates model choice to Copilot. */
const model = process.env.COPILOT_MODEL || "auto";

/** Prefix that separates this app's sessions from unrelated Copilot CLI sessions. */
const sessionPrefix = "copilotkit-";

/**
 * Opens the SDK session associated with a CopilotKit thread.
 *
 * The SDK keeps its own transcript, so a later turn resumes it instead of forwarding
 * the CopilotKit message array again. Only this app's prefixed session ID is used.
 *
 * @param threadId - Nonempty CopilotKit thread identifier; stable across turns.
 * @returns A connected session owned by the caller, which must disconnect it.
 * @throws If the Copilot runtime is unavailable or session creation or resume fails.
 * @remarks The runtime's per-thread runner prevents simultaneous runs on the same thread.
 */
async function openSession(threadId: string): Promise<CopilotSession> {
  await client.start();
  const sessionId = `${sessionPrefix}${threadId}`;

  // A listed session has already been created, so keep the SDK transcript as the source of context.
  const sessions = await client.listSessions();
  if (sessions.some((session) => session.sessionId === sessionId)) {
    return client.resumeSession(sessionId, { streaming: true });
  }

  // New threads start with the configured model; later turns resume the stored transcript.
  return client.createSession({ sessionId, model, streaming: true });
}

/**
 * Runs GitHub Copilot as a CopilotKit agent using the AG-UI event contract.
 *
 * The CopilotKit runtime clones this instance for each request. It carries no
 * instance configuration, so the base clone retains everything it needs.
 */
export class CopilotSdkAgent extends AbstractAgent {
  /**
   * Streams the newest user prompt from one CopilotKit thread through its SDK session.
   *
   * @param input - AG-UI run input; its last message must be nonempty user text.
   * @returns A cold event stream whose subscription owns the SDK turn and cancellation.
   * @throws Stream errors if session startup, the model request, or cleanup fails.
   * @remarks Unsubscribing aborts the active SDK turn; normal completion disconnects the session while preserving its transcript.
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let session: CopilotSession | undefined;
      let cancelled = false;
      const lastMessage = input.messages.at(-1);
      const prompt = lastMessage?.role === "user" && typeof lastMessage.content === "string"
        ? lastMessage.content.trim()
        : "";

      // An SDK turn must receive only the new user prompt; prior turns live in its session.
      if (!prompt) {
        subscriber.error(new Error("The latest CopilotKit message must contain user text."));
        return;
      }

      const messageId = crypto.randomUUID();
      let emittedText = false;
      const { threadId, runId } = input;

      /** Owns the asynchronous SDK turn and closes the AG-UI stream after cleanup. */
      async function execute(): Promise<void> {
        try {
          // Establish the session before emitting run events, so startup errors become stream errors.
          session = await openSession(threadId);
          if (cancelled) {
            await session.disconnect();
            return;
          }

          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });

          // SDK deltas are ephemeral; ignore sub-agent replies because they are not the chat response.
          const unsubscribe = session.on("assistant.message_delta", (event) => {
            // A child agent's text and a cancelled browser stream must not enter the main chat.
            if (event.agentId || subscriber.closed) return;
            emittedText = true;
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: event.data.deltaContent,
            });
          });

          try {
            const response = await session.sendAndWait({ prompt });
            // Some SDK runtimes return a final message without emitting text deltas.
            if (!emittedText && response?.data.content && !subscriber.closed) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: response.data.content,
              });
            }
          } finally {
            unsubscribe();
          }

          // Disconnect only after the turn settles so the SDK can persist its transcript.
          await session.disconnect();
          session = undefined;
          if (subscriber.closed) return;
          subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId });
          subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
          subscriber.complete();
        } catch (error) {
          // Cleanup failure must not replace the original model or transport error.
          if (session) await session.disconnect().catch(() => undefined);
          if (!subscriber.closed) subscriber.error(error);
        }
      }

      void execute();

      // CopilotKit's stop path unsubscribes; aborting also stops SDK tool activity.
      return () => {
        cancelled = true;
        // Cancellation is best effort because the request may already have finished.
        if (session) void session.abort().catch(() => undefined);
      };
    });
  }
}
