import CDP from "chrome-remote-interface";
import { sendToExtension } from "../cdp/helpers.js";
import { agentState } from "../state/agent.js";
import { getRandomThought } from "./thoughts.js";

export const HumanPace = {
  afterRead: () => sleep(randomBetween(800, 2500)),
  betweenClicks: () => sleep(randomBetween(300, 800)),
  afterNavigate: () => sleep(randomBetween(1500, 3500)),
  thinkingPause: () => sleep(randomBetween(2000, 5000)),
  fieldToField: () => sleep(randomBetween(400, 900)),
  beforeSubmit: () => sleep(randomBetween(500, 1500)),
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

export interface ToolCallMetrics {
  tool: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  timestamp: number;
}

const toolCallLog: ToolCallMetrics[] = [];
const MAX_LOG_SIZE = 100;

function estimateTokens(obj: unknown): number {
  try {
    return Math.ceil(JSON.stringify(obj).length / 4);
  } catch {
    return 0;
  }
}

function recordMetrics(metrics: ToolCallMetrics): void {
  toolCallLog.push(metrics);
  if (toolCallLog.length > MAX_LOG_SIZE) toolCallLog.shift();
}

export function getUsageStats() {
  const byTool = new Map<string, { calls: number; tokens: number; totalLatencyMs: number }>();

  for (const entry of toolCallLog) {
    const existing = byTool.get(entry.tool) ?? { calls: 0, tokens: 0, totalLatencyMs: 0 };
    existing.calls++;
    existing.tokens += entry.totalTokens;
    existing.totalLatencyMs += entry.latencyMs;
    byTool.set(entry.tool, existing);
  }

  const totalCalls = toolCallLog.length;
  const totalTokens = toolCallLog.reduce((s, e) => s + e.totalTokens, 0);

  const toolEntries = [...byTool.entries()].map(([tool, data]) => ({
    tool,
    calls: data.calls,
    tokens: data.tokens,
    avgLatencyMs: Math.round(data.totalLatencyMs / data.calls),
  }));

  const topSlowest = [...toolCallLog]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 5)
    .map((e) => `${e.tool} (${e.latencyMs}ms)`);

  return { totalCalls, totalTokens, byTool: toolEntries, topSlowest };
}

export async function agentAction(
  session: CDP.Client,
  type: "clicking" | "typing" | "reading" | "thinking" | "navigating",
  fn: () => Promise<any>,
  toolName?: string
) {
  agentState.reportToolCall();

  const thought = getRandomThought(type);
  sendToExtension(session, {
    type: "Weavetab_STATE",
    state: type,
    ...(thought ? { hud: { action: thought } } : {}),
  }).catch(() => {});

  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;

  if (result && typeof result === "object") {
    (result as any).execution_ms = elapsed;
  }

  if (toolName) {
    const inputTokens = 0;
    const outputTokens = estimateTokens(result);
    const metrics: ToolCallMetrics = {
      tool: toolName,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      latencyMs: elapsed,
      timestamp: start,
    };
    recordMetrics(metrics);

    const liveConfig = (global as any).__wt_live_config;
    if (liveConfig?.devMode === true) {
      const stats = getUsageStats();
      process.stderr.write(
        `\n┌─ Tool Call ──────────────────────────────────────────┐\n` +
          `│ ${toolName.padEnd(50)} │\n` +
          `│ Input: ${String(inputTokens).padStart(4)} tokens  │  Latency: ${String(elapsed).padStart(6)}ms       │\n` +
          `│ Output: ${String(outputTokens).padStart(4)} tokens │  Total:   ${String(metrics.totalTokens).padStart(4)} tokens      │\n` +
          `│ ──────────────────────────────────────────────────── │\n` +
          `│ Session total: ${stats.totalTokens} tokens (${stats.totalCalls} calls)`.padEnd(53) +
          `│\n` +
          `└──────────────────────────────────────────────────────┘\n`
      );
    }
  }

  return result;
}
