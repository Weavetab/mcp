import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";
import { sendToExtension } from "../cdp/helpers.js";
import type { Config } from "../config/loader.js";

interface PlanTask {
  id: number;
  description: string;
  status: "pending" | "in-progress" | "done" | "failed";
  comment?: string;
}

export interface PlanOptions {
  action: "create" | "update" | "comments" | "hide";
  goal?: string;
  tasks?: PlanTask[];
  taskId?: number;
  status?: PlanTask["status"];
}

interface PlanComment {
  taskId: number;
  comment: string;
  time: number;
}

// In-memory comment store (agent-side)
const planComments: PlanComment[] = [];

let activeGoal = "";
let activeTasks: PlanTask[] = [];

// Dormant Guard (Layer 1)
let dormantTimer: ReturnType<typeof setTimeout> | null = null;
const DORMANT_TIMEOUT_MS = 45000;

function resetDormantGuard(session: CDP.Client) {
  if (dormantTimer) clearTimeout(dormantTimer);
  dormantTimer = setTimeout(async () => {
    try {
      await session.Runtime.evaluate({
        expression: `(function() { if (typeof window.__wt_plan === 'function') window.__wt_plan('hide'); })()`
      });
    } catch { /* session may be dead */ }
  }, DORMANT_TIMEOUT_MS);
}

/** Poll the page for new user comments on plan tasks */
async function pollComments(session: CDP.Client): Promise<PlanComment[]> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        var q = window.__wt_plan_comments || [];
        if (q.length > 0) { window.__wt_plan_comments = []; return JSON.stringify(q); }
        return '[]';
      })()`,
      returnByValue: true,
    });
    if (result?.value && result.value !== '[]') {
      return JSON.parse(result.value as string);
    }
  } catch { /* non-fatal */ }
  return [];
}

export async function weavePlan(
  session: CDP.Client,
  options: PlanOptions,
  _config: Config
): Promise<{ success: boolean; plan?: { goal: string; tasks: PlanTask[] }; comments?: PlanComment[]; error?: string }> {
  const { action, goal, tasks, taskId, status } = options;

  // Always poll for new user comments from the overlay
  const newComments = await pollComments(session);
  for (const c of newComments) {
    planComments.push(c);
    const task = activeTasks.find(t => t.id === c.taskId);
    if (task) {
      task.comment = c.comment;
      logAction("browser_plan", "comment", `task ${c.taskId}: ${c.comment}`);
    }
  }

  if (action === "create") {
    activeGoal = goal || "";
    activeTasks = tasks || [];

    // Use sendToExtension for reliable delivery to content script
    await sendToExtension(session, {
      type: 'Weavetab_STATE',
      plan: { action: 'create', goal: activeGoal, tasks: activeTasks },
    }).catch(() => {});

    // Also try direct injection as fallback
    await session.Runtime.evaluate({
      expression: `(function() {
        if (typeof window.__wt_plan === 'function') {
          window.__wt_plan('create', ${JSON.stringify(activeGoal)}, ${JSON.stringify(activeTasks)});
        }
      })()`,
      returnByValue: true,
    }).catch(() => {});

    resetDormantGuard(session);
    logAction("browser_plan", "create", `goal: ${activeGoal}, ${activeTasks.length} tasks`);
    return { success: true, plan: { goal: activeGoal, tasks: activeTasks } };
  }

  if (action === "update") {
    if (taskId === undefined || !status) {
      return { success: false, error: "browser_plan update requires taskId and status" };
    }

    const task = activeTasks.find(t => t.id === taskId);
    if (!task) {
      return { success: false, error: `Task ${taskId} not found` };
    }
    task.status = status;

    // Use sendToExtension for reliable delivery
    await sendToExtension(session, {
      type: 'Weavetab_STATE',
      plan: { action: 'update', goal: activeGoal, tasks: activeTasks },
    }).catch(() => {});

    // Also try direct injection as fallback
    await session.Runtime.evaluate({
      expression: `(function() {
        if (typeof window.__wt_plan === 'function') {
          window.__wt_plan('update', ${JSON.stringify(activeGoal)}, ${JSON.stringify(activeTasks)});
        }
      })()`,
      returnByValue: true,
    }).catch(() => {});

    resetDormantGuard(session);
    logAction("browser_plan", "update", `task ${taskId} \u2192 ${status}`);
    return { success: true, plan: { goal: activeGoal, tasks: activeTasks } };
  }

  if (action === "hide") {
    if (dormantTimer) { clearTimeout(dormantTimer); dormantTimer = null; }

    // Use sendToExtension for reliable delivery
    await sendToExtension(session, {
      type: 'Weavetab_STATE',
      plan: { action: 'hide', goal: '', tasks: [] },
    }).catch(() => {});

    // Also try direct injection as fallback
    await session.Runtime.evaluate({
      expression: `(function() {
        if (typeof window.__wt_plan === 'function') window.__wt_plan('hide');
      })()`,
      returnByValue: true,
    }).catch(() => {});

    return { success: true };
  }

  if (action === "comments") {
    return { success: true, comments: planComments.slice(), plan: { goal: activeGoal, tasks: activeTasks } };
  }

  return { success: false, error: `Unknown action: ${action}` };
}

export function addPlanComment(taskId: number, comment: string): void {
  planComments.push({ taskId, comment, time: Date.now() });
}

/** Returns current in-memory plan (goal + tasks) — used to re-inject on page navigation */
export function getActivePlan(): { goal: string; tasks: PlanTask[] } | null {
  if (!activeGoal && activeTasks.length === 0) return null;
  return { goal: activeGoal, tasks: activeTasks };
}

export function setActivePlan(goal: string, tasks: PlanTask[]): void {
  activeGoal = goal || "";
  activeTasks = tasks || [];
}

/** Re-inject plan into a (possibly fresh) page session — used after navigation / reconnect */
export async function restoreActivePlanIntoPage(session: CDP.Client): Promise<void> {
  if (!activeGoal && activeTasks.length === 0) return;

  // Use sendToExtension for reliable delivery
  try {
    await sendToExtension(session, {
      type: 'Weavetab_STATE',
      plan: { action: 'create', goal: activeGoal, tasks: activeTasks },
    });
  } catch { /* non-fatal */ }

  // Also try direct injection as fallback
  try {
    await session.Runtime.evaluate({
      expression: `(function() {
        if (typeof window.__wt_plan === 'function') {
          window.__wt_plan('create', ${JSON.stringify(activeGoal)}, ${JSON.stringify(activeTasks)});
        }
      })()`,
      returnByValue: true,
    });
  } catch { /* page may not be ready */ }
}
