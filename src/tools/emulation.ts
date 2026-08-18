/**
 * Weavetab — tools/emulation.ts
 * browser_emulate: Network, CPU, Geolocation, and Device emulation over CDP.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { logAction } from "../audit/logger.js";

export interface EmulationOptions {
  /** Network throttling profile or custom parameters */
  network?: "offline" | "slow3g" | "fast3g" | "4g" | "online" | {
    offline?: boolean;
    latency?: number;
    downloadThroughput?: number;
    uploadThroughput?: number;
  };
  /** CPU slowdown multiplier (e.g. 2 for 2x slowdown, 4 for 4x slowdown, 1 to disable) */
  cpuThrottlingRate?: number;
  /** Override geolocation coordinates */
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  /** Override browser timezone (e.g. "America/New_York", "Europe/London") */
  timezoneId?: string;
  /** User Agent string override */
  userAgent?: string;
}

const PRESET_NETWORK_PROFILES = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 400, downloadThroughput: 500 * 1024 / 8, uploadThroughput: 500 * 1024 / 8 },
  fast3g: { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  "4g": { offline: false, latency: 50, downloadThroughput: 10 * 1024 * 1024 / 8, uploadThroughput: 5 * 1024 * 1024 / 8 },
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

export async function browserEmulate(
  session: CDP.Client,
  options: EmulationOptions,
  _config: Config
): Promise<{ success: boolean; applied: string[]; error?: string }> {
  const applied: string[] = [];

  try {
    // 1. Network Throttling
    if (options.network) {
      await session.Network.enable();
      let params = typeof options.network === "string" 
        ? PRESET_NETWORK_PROFILES[options.network]
        : options.network;

      if (params) {
        await session.Network.emulateNetworkConditions({
          offline: params.offline ?? false,
          latency: params.latency ?? 0,
          downloadThroughput: params.downloadThroughput ?? -1,
          uploadThroughput: params.uploadThroughput ?? -1,
        });
        applied.push(`network: ${typeof options.network === "string" ? options.network : "custom"}`);
      }
    }

    // 2. CPU Throttling
    if (options.cpuThrottlingRate !== undefined) {
      await session.Emulation.setCPUThrottlingRate({
        rate: options.cpuThrottlingRate,
      });
      applied.push(`cpuThrottlingRate: ${options.cpuThrottlingRate}x`);
    }

    // 3. Geolocation Override
    if (options.geolocation) {
      await session.Emulation.setGeolocationOverride({
        latitude: options.geolocation.latitude,
        longitude: options.geolocation.longitude,
        accuracy: options.geolocation.accuracy ?? 1,
      });
      applied.push(`geolocation: ${options.geolocation.latitude}, ${options.geolocation.longitude}`);
    }

    // 4. Timezone Override
    if (options.timezoneId) {
      await session.Emulation.setTimezoneOverride({
        timezoneId: options.timezoneId,
      });
      applied.push(`timezoneId: ${options.timezoneId}`);
    }

    // 5. User Agent Override
    if (options.userAgent) {
      await session.Network.setUserAgentOverride({
        userAgent: options.userAgent,
      });
      applied.push(`userAgent: ${options.userAgent}`);
    }

    logAction("browser_emulate", "emulation", applied.join(", "));
    return { success: true, applied };
  } catch (err: any) {
    return { success: false, applied, error: err?.message || String(err) };
  }
}
