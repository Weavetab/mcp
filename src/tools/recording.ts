/**
 * Weavetab — tools/recording.ts
 * browser_recording: Session recording (screencast) for compliance review.
 * Uses CDP Page.startScreencast at 2-5 FPS and compiles frames into video (.webp, .gif, .webm, .mp4).
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../config/loader.js";
import { getOutputDir } from "../config/loader.js";
import { logAction } from "../audit/logger.js";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";
import { sessionRegistry } from "../state/session.js";
import { compileVideo } from "./video_compiler.js";

export interface RecordingOptions {
  action: "start" | "stop" | "list";
  sessionId?: string;
  fps?: number;
  maxFrames?: number;
  /** Output video/animation format when stopping recording.
   * Options: 'webp' (default pure Node animation), 'gif', 'webm', 'mp4', or 'frames' (raw images). */
  format?: "webp" | "gif" | "webm" | "mp4" | "frames";
  /** If false (default), cleans up raw JPEG image frames after video compilation. */
  keepFrames?: boolean;
  /** If false, keeps the WeaveTab UI overlay visible in the recording.
   * Default: true — overlay is hidden from screencasts so agent never records itself. */
  hideOverlay?: boolean;
}

interface RecordingState {
  sessionId: string;
  targetId: string;
  startedAt: string;
  fps: number;
  maxFrames: number;
  frameCount: number;
  dir: string;
  active: boolean;
}

const activeRecordings = new Map<string, RecordingState>();
let screencastListener: ((frame: any) => void) | null = null;
let currentSession: CDP.Client | null = null;

function recordingDir(sessionId: string, config: Config): string {
  return path.join(getOutputDir("recordings", config), sessionId);
}

export async function browserRecording(
  session: CDP.Client,
  options: RecordingOptions,
  config: Config
): Promise<{
  success: boolean;
  recordings?: RecordingState[];
  error?: string;
  dir?: string;
  frameCount?: number;
  videoPath?: string;
  videoFormat?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
  compilerUsed?: string;
}> {
  const { action, sessionId, fps = 3, maxFrames = 500 } = options;

  if (action === "start") {
    if (!sessionId) return { success: false, error: "browser_recording start requires a 'sessionId'" };

    if (activeRecordings.has(sessionId)) {
      return { success: false, error: `Recording '${sessionId}' is already active` };
    }

    const dir = recordingDir(sessionId, config);
    fs.mkdirSync(dir, { recursive: true });

    const active = sessionRegistry.getActive(config.agentId);
    const targetId = active ? active.targetId : "default";

    const state: RecordingState = {
      sessionId,
      targetId,
      startedAt: new Date().toISOString(),
      fps: Math.max(1, Math.min(10, fps)),
      maxFrames,
      frameCount: 0,
      dir,
      active: true,
    };

    activeRecordings.set(sessionId, state);
    currentSession = session;

    const page = session.Page as any;

    // Register screencast frame handler
    if (screencastListener && currentSession) {
      (currentSession as any).removeListener("Page.screencastFrame", screencastListener);
    }
    screencastListener = async (frame: any) => {
      const s = activeRecordings.get(sessionId);
      if (!s || !s.active) return;

      s.frameCount++;
      const fname = `frame-${String(s.frameCount).padStart(6, "0")}.jpg`;
      const fpath = path.join(s.dir, fname);
      try {
        fs.writeFileSync(fpath, Buffer.from(frame.data, "base64"));
      } catch { /* disk full etc — skip frame */ }

      await page.screencastFrameAck({ sessionId: frame.sessionId }).catch(() => {});

      if (s.frameCount >= s.maxFrames) {
        await page.stopScreencast().catch(() => {});
        s.active = false;
      }
    };
    session.on("Page.screencastFrame", screencastListener);

    await page.startScreencast({
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    }).catch((e: Error) => {
      activeRecordings.delete(sessionId);
      throw new Error(`Failed to start screencast: ${e.message}`);
    });

    // Always hide overlay during recording (default true; set hideOverlay: false to skip)
    if (options.hideOverlay !== false) {
      await hideWeaveTabOverlay(session);
    }

    logAction("browser_recording", sessionId, `started (${fps}fps, max ${maxFrames} frames)`);
    return { success: true, recordings: [state], dir };
  }

  if (action === "stop") {
    if (!sessionId) return { success: false, error: "browser_recording stop requires a 'sessionId'" };

    const state = activeRecordings.get(sessionId);
    if (!state) return { success: false, error: `Recording '${sessionId}' not found` };

    state.active = false;
    try {
      await (session.Page as any).stopScreencast().catch(() => {});
    } catch { /* ignore */ }
    
    await restoreWeaveTabOverlay(session);

    if (screencastListener && currentSession) {
      (currentSession as any).removeListener("Page.screencastFrame", screencastListener);
      screencastListener = null;
      currentSession = null;
    }

    const count = state.frameCount;
    activeRecordings.delete(sessionId);

    // Compile frames into video file
    const compileRes = await compileVideo({
      recordingDir: state.dir,
      fps: state.fps,
      format: options.format || "webp",
      keepFrames: options.keepFrames ?? false,
    });

    logAction("browser_recording", sessionId, `stopped (${count} frames, compiled: ${compileRes.videoPath || "none"})`);
    return {
      success: true,
      recordings: Array.from(activeRecordings.values()),
      frameCount: count,
      dir: state.dir,
      videoPath: compileRes.videoPath,
      videoFormat: compileRes.format,
      durationSeconds: compileRes.durationSeconds,
      fileSizeBytes: compileRes.fileSizeBytes,
      compilerUsed: compileRes.compilerUsed,
    };
  }

  if (action === "list") {
    return {
      success: true,
      recordings: Array.from(activeRecordings.values()),
    };
  }

  return { success: false, error: `Unknown action: ${action}` };
}
