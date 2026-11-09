/**
 * @file Verifies the Copilot SDK to AG-UI streaming boundary with a controlled SDK session.
 * @description Checks that text reaches subscribers before the SDK turn completes.
 * @remarks This test substitutes the SDK client; it does not contact GitHub or exercise the browser renderer.
 */
import { expect, mock, test } from "bun:test";

/** Session controlled by the test so SDK callbacks can arrive independently of send(). */
class FakeSession {
  /** Registered SDK event listeners for this session's lifetime. */
  listeners = new Set();
  /** Last submitted prompt and correlation marker. */
  sendOptions;

  /** Registers a live event listener and returns its unsubscribe function. */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records the submitted prompt without waiting for model completion. */
  async send(options) {
    this.sendOptions = options;
    return "user-message";
  }

  /** Emits one SDK event to every currently subscribed listener. */
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  /** Ends the fake connection after the AG-UI run finishes. */
  async disconnect() {}

  /** Accepts cancellation without starting additional fake work. */
  async abort() {}
}

/** Shares the latest fake session with the test while matching the adapter's SDK calls. */
class FakeClient {
  /** Latest session created by the adapter. */
  static session;

  /** Starts the fake client without external I/O. */
  async start() {}

  /** Forces a new session for this isolated test thread. */
  async listSessions() {
    return [];
  }

  /** Creates the fake session used to drive the turn's event sequence. */
  async createSession() {
    FakeClient.session = new FakeSession();
    return FakeClient.session;
  }
}

// Replace the SDK before importing the adapter, whose client is constructed at module load.
mock.module("@github/copilot-sdk", () => ({
  CopilotClient: FakeClient,
  RuntimeConnection: { forUri: (uri) => uri },
}));
const { CopilotSdkAgent } = await import("../src/copilot-sdk-agent.ts");

/** Confirms that SDK deltas are forwarded before idle and that final text is not repeated. */
test("streams text before the SDK turn finishes", async () => {
  const events = [];
  const finished = new Promise((resolve, reject) => {
    new CopilotSdkAgent().run({
      threadId: "streaming-test",
      runId: "run-1",
      messages: [{ id: "input-1", role: "user", content: "hello" }],
    }).subscribe({ next: (event) => events.push(event), error: reject, complete: resolve });
  });

  // Session creation and send() finish in microtasks; the model events remain test-controlled.
  while (!FakeClient.session?.sendOptions) await Promise.resolve();
  const session = FakeClient.session;
  session.emit({ type: "user.message", data: { clientTurnId: session.sendOptions.clientTurnId } });
  session.emit({ type: "assistant.message_delta", data: { messageId: "reply-1", deltaContent: "Hel" } });
  expect(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "Hel")).toBe(true);
  expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);

  // The final message adds only the missing suffix, and idle closes the AG-UI run.
  session.emit({ type: "assistant.message", data: { messageId: "reply-1", content: "Hello" } });
  session.emit({ type: "session.idle", data: {} });
  await finished;
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta)).toEqual(["Hel", "lo"]);
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
});
