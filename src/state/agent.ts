import CDP from "chrome-remote-interface";

export type GroupState = "idle" | "weaving" | "stuck";

interface AgentStateCallbacks {
  onStateChange: (session: CDP.Client | null, state: GroupState, word?: string) => void;
  onUpdateTabTitle: (session: CDP.Client, state: GroupState) => void;
}

class AgentStateManager {
  private state: GroupState = "idle";
  private word: string | undefined = undefined;
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
    this.word = undefined;
    if (this.state !== "weaving") {
      this.transition("weaving");
    } else {
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
    this.transition("stuck", word);
  }

  reportDone() {
    this.clearIdleTimer();
    this.word = undefined;
    this.state = "idle";
    this.callbacks?.onStateChange(this.session, "idle");
    if (this.session) this.callbacks?.onUpdateTabTitle(this.session, "idle");
  }

  reportTransportClosed() {
    this.clearIdleTimer();
    const prevSession = this.session;
    this.word = undefined;
    this.state = "idle";
    this.session = null;
    this.errorStreak = 0;
    this.callbacks?.onStateChange(prevSession, "idle");
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
    const isRedundant = this.state === newState && (!word || word === this.word);
    if (isRedundant && newState !== "idle") return;
    this.state = newState;
    if (newState === "weaving" || newState === "idle") {
      this.word = undefined;
    } else if (word !== undefined) {
      this.word = word;
    }

    this.callbacks?.onStateChange(this.session, this.state, this.word);

    if (this.session) {
      this.callbacks?.onUpdateTabTitle(this.session, this.state);
    }
  }

  private startIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.word = undefined;
      this.transition("idle");
    }, this.idleTimeoutMs);
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
