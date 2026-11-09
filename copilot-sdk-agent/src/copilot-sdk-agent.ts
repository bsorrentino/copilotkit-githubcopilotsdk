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

/** Maximum wait for one SDK turn, matching the SDK's default sendAndWait timeout in milliseconds. */
const turnTimeoutMs = 60_000 * 5;

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
   * Stops the active AG-UI run when CopilotKit's runner receives a Stop request.
   *
   * Detaching the run unsubscribes its Observable, whose teardown aborts the
   * matching SDK session. The runner owns the terminal run event and UI state.
   *
   * @returns Nothing; session abort and run finalization continue asynchronously.
   * @remarks The runtime clones this agent per request, so detachment affects only that run.
   */
  override abortRun(): void {
    // Stop must detach the AG-UI pipeline before its Observable can abort the SDK turn.
    void this.detachActiveRun();
  }

  /**
   * Streams the newest user prompt from one CopilotKit thread through its SDK session.
   *
   * @param input - AG-UI run input; its last message must be nonempty user text.
   * @returns A cold event stream of assistant chunks and tool-start status messages; its subscription owns the SDK turn and cancellation.
   * @throws Stream errors if session startup, the model request, or cleanup fails.
   * @remarks Unsubscribing aborts the active SDK turn; normal completion disconnects the session while preserving its transcript.
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let session: CopilotSession | undefined;
      let cancelled = false;
      /** Rejects the active completion wait when the browser unsubscribes. */
      let cancelCompletion: ((reason: Error) => void) | undefined;
      const lastMessage = input.messages.at(-1);
      const prompt = lastMessage?.role === "user" && typeof lastMessage.content === "string"
        ? lastMessage.content.trim()
        : "";

      // An SDK turn must receive only the new user prompt; prior turns live in its session.
      if (!prompt) {
        subscriber.error(new Error("The latest CopilotKit message must contain user text."));
        return;
      }

      const { threadId, runId } = input;
      /** SDK message currently open in AG-UI; absent between messages and progress updates. */
      let activeMessageId: string | undefined;
      /** Text already forwarded for the open SDK message, used to avoid repeating the final payload. */
      let activeText = "";
      /** SDK messages already closed in AG-UI, including messages finalized before the turn becomes idle. */
      const completedMessageIds = new Set<string>();

      /**
       * Closes the current assistant message before another SDK message or tool status starts.
       *
       * @remarks AG-UI requires each started text message to end before the run finishes.
       */
      function endMessage(): void {
        // No AG-UI end event is valid until text has opened a message.
        if (!activeMessageId) return;
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: activeMessageId });
        completedMessageIds.add(activeMessageId);
        activeMessageId = undefined;
        activeText = "";
      }

      /**
       * Appends one SDK text chunk to its matching AG-UI assistant message.
       *
       * @param sdkMessageId - SDK identifier shared by deltas and their final message.
       * @param delta - New text only; empty chunks produce no AG-UI event.
       * @remarks SDK callbacks and the final response run on this subscription's event loop.
       */
      function appendText(sdkMessageId: string, delta: string): void {
        // Empty or late chunks cannot change a completed chat message.
        if (!delta || subscriber.closed || completedMessageIds.has(sdkMessageId)) return;
        if (activeMessageId !== sdkMessageId) {
          endMessage();
          activeMessageId = sdkMessageId;
          subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: sdkMessageId, role: "assistant" });
        }
        activeText += delta;
        subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: sdkMessageId, delta });
      }

      /**
       * Completes a streamed SDK message, adding any final text that its deltas omitted.
       *
       * @param sdkMessageId - Identifier of the finalized SDK message.
       * @param content - Authoritative full text; empty tool-only messages stay out of chat.
       * @remarks A non-prefix correction cannot be expressed as an AG-UI append, so streamed text remains visible as received.
       */
      function finishText(sdkMessageId: string, content: string): void {
        // The final SDK response can repeat a message already finalized by its event callback.
        if (completedMessageIds.has(sdkMessageId) || subscriber.closed) return;
        if (content.startsWith(activeMessageId === sdkMessageId ? activeText : "")) {
          appendText(sdkMessageId, content.slice(activeMessageId === sdkMessageId ? activeText.length : 0));
        }
        if (activeMessageId === sdkMessageId) endMessage();
      }

      /**
       * Shows a tool's public display name as a completed progress line in the chat.
       *
       * @param title - SDK tool title or name; arguments and results are intentionally excluded.
       */
      function showToolProgress(title: string): void {
        // A stopped browser stream must not receive new progress messages.
        if (subscriber.closed) return;
        endMessage();
        const progressId = crypto.randomUUID();
        subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: progressId, role: "assistant" });
        subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: progressId, delta: `Using ${title}…` });
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: progressId });
      }

      /**
       * Runs one SDK turn and forwards live session events until its response completes.
       *
       * Opens the thread session before starting the AG-UI run, then disconnects after
       * the response so the SDK transcript can be resumed on a later request.
       * @throws For startup, model, transport, or disconnect errors while subscribed.
       * @remarks Cancellation aborts the session from the Observable teardown path.
       */
      async function execute(): Promise<void> {
        try {
          // Establish the session before emitting run events, so startup errors become stream errors.
          session = await openSession(threadId);
          if (cancelled) {
            await session.disconnect();
            return;
          }

          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          /** Client-owned marker echoed by user.message when this queued prompt is consumed. */
          const clientTurnId = crypto.randomUUID();
          /** Prevents an unrelated idle event from closing this AG-UI run. */
          let requestStarted = false;
          /** SDK user-message ID returned by send, used for autopilot completion correlation. */
          let sentMessageId: string | undefined;
          /** Settles the wait when this turn emits its terminal SDK event. */
          //let resolveCompletion!: () => void;
          /** Fails the wait on SDK error, cancellation, abort, or timeout. */
          //let rejectCompletion!: (reason: Error) => void;
          
          const { 
            promise:  completion, 
            resolve:  resolveCompletion, 
            reject:   rejectCompletion 
          } = Promise.withResolvers<void>();

          cancelCompletion = rejectCompletion;

          // Handle a terminal event even if it arrives before session.send resolves.
          void completion.catch(() => undefined);

          // Keep assistant chunks separate by SDK message ID and surface tool starts as chat progress.
          const unsubscribe = session.on((event) => {
            if (event.agentId || subscriber.closed) return;
            switch (event.type) {
              case "user.message":
                if (event.data.clientTurnId === clientTurnId) requestStarted = true;
                break;
              case "assistant.message_delta":
                appendText(event.data.messageId, event.data.deltaContent);
                break;
              case "assistant.message":
                finishText(event.data.messageId, event.data.content);
                break;
              case "tool.execution_start":
                showToolProgress( 
                  `<div style="max-width:600px; margin:20px auto; border:1px solid #d0d7de; border-radius:8px; overflow:hidden; font-family:sans-serif;">
                    <div style="background:#f6f8fa; padding:8px 12px; border-bottom:1px solid #d0d7de; font-size:13px; font-weight:bold; color:#24292f;">
                    ${event.data.toolTitle ?? ''}
                    </div>
                    <pre style="margin:0; padding:12px; background:#0d1117; color:#c9d1d9; font-family:Consolas,Menlo,monospace; font-size:14px; line-height:1.5; overflow-x:auto;">
                      <code>${event.data.toolName}(${JSON.stringify(event.data.arguments?? '{}')})</code>
                    </pre>
                  </div>`);
                break;
              case "session.idle":
                // Only the idle event after our user message completes this turn.
                if (requestStarted && event.data.mode !== "autopilot") {
                  if (event.data.aborted) rejectCompletion(new Error("The Copilot turn was aborted."));
                  else resolveCompletion();
                }
                break;
              case "session.autopilot_stopped":
                if (sentMessageId && event.data.requestId === sentMessageId) {
                  if (event.data.reason === "aborted" || event.data.reason === "error") {
                    rejectCompletion(new Error(`The Copilot turn ${event.data.reason}.`));
                  } else {
                    resolveCompletion();
                  }
                }
                break;
              case "session.error":
                // This session belongs to one CopilotKit thread and has one in-flight turn.
                rejectCompletion(new Error(event.data.message));
                break;
            }
          });

          const timeout = setTimeout(() => {
            rejectCompletion(new Error("Timed out waiting for Copilot to finish the turn."));
          }, turnTimeoutMs);
          try {
            // send queues the prompt while SDK callbacks forward deltas immediately.
            sentMessageId = await session.send({ prompt, clientTurnId });
            await completion;
          } finally {
            cancelCompletion = undefined;
            clearTimeout(timeout);
            unsubscribe();
          }

          // Disconnect only after the turn settles so the SDK can persist its transcript.
          await session.disconnect();
          session = undefined;
          if (subscriber.closed) return;
          endMessage();
          subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
          subscriber.complete();
        } catch (error) {
          // Cleanup failure must not replace the original model or transport error.
          if (session) await session.disconnect().catch(() => undefined);
          if (!subscriber.closed) subscriber.error(error);
        }
      }

      void execute();

      // Detaching the active run unsubscribes here; aborting also stops SDK tool activity.
      return () => {
        console.log( "Cancelling CopilotKit stream" )
        cancelled = true;
        cancelCompletion?.(new Error("The CopilotKit stream was cancelled."));
        // Cancellation is best effort because the request may already have finished.
        if (session) void session.abort().catch(() => undefined);
      };
    });
  }
}
