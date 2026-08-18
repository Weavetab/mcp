/**
 * Weavetab — lifecycle/mission_manager.ts
 * Mission Lifecycle Manager (MLM)
 * Handles suspension, hibernation, and resumption of Weavetab missions.
 * Weavetab by fy2ne
 */

import { getActivePlan } from "../tools/plan.js";
import { getTabList } from "../cdp/connector.js";
import { sessionRegistry } from "../state/session.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSystemDir } from "../config/loader.js";

export interface MissionState {
  missionId: string;
  agentId: string;
  status: "active" | "suspended" | "completed";
  timestamp: number;
  plan: any;
  tabs: any[];
}

const stateDir = getSystemDir("missions");

function getMissionPath(missionId: string) {
  return path.join(stateDir, `mission_${missionId}.json`);
}

export async function suspendMission(agentId: string, missionId: string): Promise<void> {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const plan = getActivePlan();
  const tabs = await getTabList(agentId).catch(() => []);

  const state: MissionState = {
    missionId,
    agentId,
    status: "suspended",
    timestamp: Date.now(),
    plan,
    tabs
  };

  fs.writeFileSync(getMissionPath(missionId), JSON.stringify(state, null, 2));
}

export function resumeMission(missionId: string): MissionState | null {
  const p = getMissionPath(missionId);
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return data;
    } catch {
      return null;
    }
  }
  return null;
}
