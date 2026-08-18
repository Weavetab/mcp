/**
 * Weavetab — tools/viewport.ts
 * browser_viewport: Enhanced viewport emulation with device presets, mobile support, 
 * geolocation, locale, timezone, and advanced features to surpass Playwright.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

export interface ViewportOptions {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  action: "set" | "clear" | "list" | "preset";
  devicePreset?: string;
  userAgent?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  hasTouch?: boolean;
  screenOrientation?: 'portrait' | 'landscape' | 'none';
}

export interface DevicePreset {
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  screenOrientation?: 'portrait' | 'landscape';
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iPhone 15 Pro': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'iPhone 15 Pro Max': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'iPhone 14': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'iPhone 14 Pro': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'iPad Pro 12.9': {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'Samsung Galaxy S24': {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'Samsung Galaxy S24 Ultra': {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'Pixel 8 Pro': {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    screenOrientation: 'portrait'
  },
  'Desktop 1920x1080': {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    screenOrientation: 'landscape'
  },
  'Desktop 1366x768': {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    screenOrientation: 'landscape'
  },
  'Laptop 1440x900': {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    screenOrientation: 'landscape'
  }
};

export async function browserViewport(
  session: CDP.Client,
  options: ViewportOptions,
  _config: Config
): Promise<{ success: boolean; message: string; data?: any }> {
  const { 
    action, 
    width, 
    height, 
    deviceScaleFactor = 1, 
    mobile = false,
    devicePreset,
    userAgent,
    geolocation,
    locale,
    timezoneId,
    colorScheme,
    hasTouch,
    screenOrientation
  } = options;

  if (action === "list") {
    return {
      success: true,
      message: "Available device presets",
      data: Object.keys(DEVICE_PRESETS).map(key => ({
        devicePreset: key,
        ...DEVICE_PRESETS[key]
      }))
    };
  }

  if (action === "preset") {
    if (!devicePreset) {
      throw new Error("devicePreset is required for preset action");
    }
    
    const preset = DEVICE_PRESETS[devicePreset];
    if (!preset) {
      throw new Error(`Unknown device preset: ${devicePreset}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
    }

    await applyViewportEmulation(session, {
      width: preset.viewport.width,
      height: preset.viewport.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile,
      hasTouch: preset.hasTouch,
      screenOrientation: preset.screenOrientation,
      userAgent: preset.userAgent,
      geolocation,
      locale,
      timezoneId,
      colorScheme
    });

    return {
      success: true,
      message: `Applied device preset: ${devicePreset}`,
      data: { devicePreset, ...preset }
    };
  }

  if (action === "clear") {
    await session.Emulation.clearDeviceMetricsOverride();
    await session.Network.setUserAgentOverride({ userAgent: '' });
    await session.Emulation.clearGeolocationOverride();
    await session.Emulation.setTimezoneOverride({ timezoneId: '' });
    return { success: true, message: "Cleared all viewport emulation" };
  }

  if (action === "set") {
    const hasViewport = width !== undefined && height !== undefined;
    const hasEmulation = geolocation !== undefined || timezoneId !== undefined || locale !== undefined || colorScheme !== undefined;

    if (!hasViewport && !hasEmulation) {
      throw new Error("Provide width/height for viewport, or geolocation/timezone/locale/colorScheme for emulation");
    }

    if (hasViewport) {
      await applyViewportEmulation(session, {
        width,
        height,
        deviceScaleFactor,
        mobile,
        hasTouch,
        screenOrientation,
        userAgent,
        geolocation,
        locale,
        timezoneId,
        colorScheme
      });

      return {
        success: true,
        message: `Viewport set to ${width}x${height} (mobile: ${mobile}, dpr: ${deviceScaleFactor}, touch: ${hasTouch})`
      };
    }

    // Emulation-only: apply geo/timezone/locale/colorScheme without touching viewport dimensions
    const msg: string[] = [];
    if (geolocation) {
      await session.Emulation.setGeolocationOverride({
        latitude: geolocation.latitude,
        longitude: geolocation.longitude,
        accuracy: geolocation.accuracy || 100
      });
      msg.push(`Geolocation set to ${geolocation.latitude}, ${geolocation.longitude}`);
    }
    if (timezoneId) {
      await session.Emulation.setTimezoneOverride({ timezoneId });
      msg.push(`Timezone set to ${timezoneId}`);
    }
    if (locale) {
      await session.Emulation.setLocaleOverride({ locale });
      msg.push(`Locale set to ${locale}`);
    }
    if (colorScheme && colorScheme !== 'no-preference') {
      await session.Emulation.setEmulatedMedia({
        features: [{ name: 'prefers-color-scheme', value: colorScheme }]
      });
      msg.push(`Color scheme set to ${colorScheme}`);
    }

    return { success: true, message: msg.join('. ') };
  }

  throw new Error("Unknown action");
}

async function applyViewportEmulation(
  session: CDP.Client,
  options: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
    hasTouch?: boolean;
    screenOrientation?: 'portrait' | 'landscape' | 'none';
    userAgent?: string;
    geolocation?: { latitude: number; longitude: number; accuracy?: number };
    locale?: string;
    timezoneId?: string;
    colorScheme?: 'light' | 'dark' | 'no-preference';
  }
) {
  const {
    width,
    height,
    deviceScaleFactor,
    mobile,
    hasTouch = mobile,
    screenOrientation,
    userAgent,
    geolocation,
    locale,
    timezoneId,
    colorScheme
  } = options;

  // Set device metrics override
  const orientation = screenOrientation === 'none' ? undefined : 
    screenOrientation === 'landscape' 
      ? { type: 'landscapePrimary' as const, angle: 90 }
      : { type: 'portraitPrimary' as const, angle: 0 };

  await session.Emulation.setDeviceMetricsOverride({
    width,
    height,
    deviceScaleFactor,
    mobile,
    screenOrientation: orientation
  });

  // Set user agent if provided
  if (userAgent) {
    await session.Network.setUserAgentOverride({ userAgent });
  }

  // Set geolocation if provided
  if (geolocation) {
    await session.Emulation.setGeolocationOverride({
      latitude: geolocation.latitude,
      longitude: geolocation.longitude,
      accuracy: geolocation.accuracy || 100
    });
  }

  // Set timezone if provided
  if (timezoneId) {
    await session.Emulation.setTimezoneOverride({ timezoneId });
  }

  // Set locale if provided
  if (locale) {
    await session.Emulation.setLocaleOverride({ locale });
  }

  // Set color scheme if provided
  if (colorScheme && colorScheme !== 'no-preference') {
    await session.Emulation.setEmulatedMedia({
      features: [{ name: 'prefers-color-scheme', value: colorScheme }]
    });
  }
}
