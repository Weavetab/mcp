import CDP from "chrome-remote-interface";

export type GroupState = "idle" | "weaving" | "stuck";

interface AgentStateCallbacks {
  onStateChange: (session: CDP.Client | null, state: GroupState, word?: string) => void;
  onUpdateTabTitle: (session: CDP.Client, state: GroupState) => void;
}

class AgentStateManager {
  private state: GroupState = "idle";
  private word = "";
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: AgentStateCallbacks | null = null;
  private session: CDP.Client | null = null;
  private errorStreak = 0;

  constructor(idleTimeoutMs = 60000) {
    this.idleTimeoutMs = idleTimeoutMs;
  }

  setCallbacks(cb: AgentStateCallbacks) {
    this.callbacks = cb;
  }

  setSession(session: CDP.Client) {
    this.session = session;
  }

  getSession(): CDP.Client | null {
    return this.session;
  }

  setIdleTimeout(ms: number) {
    this.idleTimeoutMs = ms;
  }

  reportToolCall() {
    this.clearIdleTimer();
    if (this.state !== "weaving") {
      this.transition("weaving");
    } else {
      // Always fire onStateChange so activeSessionTabId stays in sync
      this.callbacks?.onStateChange(this.session, this.state, this.word);
    }
    this.startIdleTimer();
  }

  reportToolSuccess() {
    this.errorStreak = 0;
  }

  reportToolError() {
    this.errorStreak++;
    if (this.errorStreak >= 5) {
      this.reportStuck("error_streak");
    }
  }

  reportStuck(word: string) {
    this.clearIdleTimer();
    this.word = word;
    this.transition("stuck", word);
  }

  reportDone() {
    this.clearIdleTimer();
    this.word = "";
    this.state = "idle";
    // Always broadcast — bypasses guard to ensure favicon/tab cleanup
    this.callbacks?.onStateChange(this.session, "idle");
    if (this.session) this.callbacks?.onUpdateTabTitle(this.session, "idle");
  }

  reportTransportClosed() {
    this.clearIdleTimer();
    this.word = "";
    this.state = "idle";
    this.callbacks?.onStateChange(this.session, "idle");
  }

  getState() {
    return { state: this.state, word: this.word };
  }

  isStuck(): boolean {
    return this.state === "stuck";
  }

  resetErrorStreak() {
    this.errorStreak = 0;
  }

  private transition(newState: GroupState, word?: string) {
    // Always fire the callback for 'idle' so favicon dots get cleared on every tab
    const isRedundant = this.state === newState && (!word || word === this.word);
    if (isRedundant && newState !== "idle") return;
    this.state = newState;
    if (word !== undefined) this.word = word;

    this.callbacks?.onStateChange(this.session, this.state, this.word);

    if (this.session) {
      this.callbacks?.onUpdateTabTitle(this.session, this.state);
    }
  }

  private startIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.word = "";
      this.transition("idle");
    }, this.idleTimeoutMs);
    // unref() so this timer does not pin the Node.js event loop. Without this,
    // the process stays alive indefinitely between tool calls even when the IDE
    // is idle and nothing else is running.
    this.idleTimer.unref();
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export const agentState = new AgentStateManager();
