/**
 * Weavetab — tools/video_compiler.ts
 * Assembles screencast JPEG frames into video/animation files (.webp, .gif, .webm, .mp4).
 * Uses native sharp (built-in Node dependency) for WebP/GIF animations without external setup.
 * Falls back to ffmpeg if installed for .mp4/.webm video encoding.
 * Weavetab by fy2ne
 */
import { exec, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CompileVideoOptions {
  recordingDir: string;
  fps: number;
  format?: "webp" | "gif" | "webm" | "mp4" | "frames";
  keepFrames?: boolean;
}

export interface CompileVideoResult {
  success: boolean;
  videoPath?: string;
  format?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
  cleanedFrames?: boolean;
  error?: string;
  compilerUsed?: string;
}

/**
 * Checks if ffmpeg is available on the system PATH.
 */
export function isFFmpegAvailable(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles JPEG frames in a directory into a video/animation file.
 */
export async function compileVideo(options: CompileVideoOptions): Promise<CompileVideoResult> {
  const { recordingDir, fps = 3, format = "webp", keepFrames = false } = options;

  if (format === "frames") {
    return {
      success: true,
      cleanedFrames: false,
      compilerUsed: "raw_frames",
    };
  }

  if (!fs.existsSync(recordingDir)) {
    return { success: false, error: `Recording directory not found: ${recordingDir}` };
  }

  const files = fs.readdirSync(recordingDir).filter(f => f.startsWith("frame-") && f.endsWith(".jpg")).sort();
  if (files.length === 0) {
    return { success: false, error: "No image frames found in recording directory" };
  }

  const durationSeconds = Math.round((files.length / fps) * 10) / 10;
  const delayMs = Math.round(1000 / Math.max(1, fps));

  // Try pure JS sharp compilation first for webp / gif (zero system dependencies required)
  if (format === "webp" || format === "gif") {
    try {
      const sharp = (await import("sharp")).default;
      
      // Load first frame metadata to determine dimensions
      const firstFramePath = path.join(recordingDir, files[0]);
      const meta = await sharp(firstFramePath).metadata();
      const width = meta.width || 1280;
      const height = meta.height || 720;

      // Limit batch size if too large to prevent out-of-memory
      const batchFiles = files.slice(0, 300);

      // Create composite list vertically stacked
      const compositeList = await Promise.all(
        batchFiles.map(async (filename, index) => ({
          input: path.join(recordingDir, filename),
          top: index * height,
          left: 0,
        }))
      );

      const canvasBuffer = await sharp({
        create: {
          width,
          height: height * batchFiles.length,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .composite(compositeList)
        .png()
        .toBuffer();

      const outputFileName = `recording.${format}`;
      const videoPath = path.join(recordingDir, outputFileName);

      let videoBuffer: Buffer;
      if (format === "gif") {
        videoBuffer = await sharp(canvasBuffer, { pageHeight: height } as any)
          .gif({ delay: delayMs })
          .toBuffer();
      } else {
        videoBuffer = await sharp(canvasBuffer, { pageHeight: height } as any)
          .webp({ loop: 0, delay: delayMs, quality: 80 })
          .toBuffer();
      }

      fs.writeFileSync(videoPath, videoBuffer);
      const fileSizeBytes = videoBuffer.length;

      // Clean up raw frames if keepFrames is false
      let cleaned = false;
      if (!keepFrames) {
        for (const f of files) {
          try {
            fs.unlinkSync(path.join(recordingDir, f));
          } catch {}
        }
        cleaned = true;
      }

      return {
        success: true,
        videoPath,
        format,
        durationSeconds,
        fileSizeBytes,
        cleanedFrames: cleaned,
        compilerUsed: "sharp_pure_node",
      };
    } catch (sharpErr: any) {
      // Fall through to ffmpeg or manifest fallback if sharp fails
    }
  }

  // Check if FFmpeg is available for webm / mp4 or fallback
  const ffmpegPresent = isFFmpegAvailable();

  if (ffmpegPresent) {
    try {
      const outputFileName = `recording.${format === "webp" || format === "gif" ? format : format}`;
      const videoPath = path.join(recordingDir, outputFileName);

      await new Promise<void>((resolve, reject) => {
        const concatFilePath = path.join(recordingDir, "concat.txt");
        const concatContent = files.map(f => `file '${f.replace(/'/g, "'\\''")}'\nduration ${1 / fps}`).join("\n");
        fs.writeFileSync(concatFilePath, concatContent);

        let codecFlags = "";
        if (format === "webm") {
          codecFlags = "-c:v libvpx-vp9 -pix_fmt yuv420p -b:v 1M";
        } else if (format === "mp4") {
          codecFlags = "-c:v libx264 -pix_fmt yuv420p -vf \"trunc(iw/2)*2:trunc(ih/2)*2\"";
        } else if (format === "gif") {
          codecFlags = `-vf "fps=${fps},scale=640:-1:flags=lanczos"`;
        } else {
          codecFlags = "-c:v libvpx-vp9 -pix_fmt yuv420p -b:v 1M";
        }

        const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" ${codecFlags} "${videoPath}"`;

        exec(cmd, { cwd: recordingDir }, (error) => {
          try { fs.unlinkSync(concatFilePath); } catch {}
          if (error) reject(error);
          else resolve();
        });
      });

      let fileSizeBytes = 0;
      if (fs.existsSync(videoPath)) {
        fileSizeBytes = fs.statSync(videoPath).size;
      }

      let cleaned = false;
      if (!keepFrames) {
        for (const f of files) {
          try { fs.unlinkSync(path.join(recordingDir, f)); } catch {}
        }
        cleaned = true;
      }

      return {
        success: true,
        videoPath,
        format,
        durationSeconds,
        fileSizeBytes,
        cleanedFrames: cleaned,
        compilerUsed: "ffmpeg_system",
      };
    } catch (err: any) {
      return {
        success: false,
        error: `FFmpeg compilation failed: ${err.message}`,
        compilerUsed: "ffmpeg_system",
      };
    }
  }

  // Final fallback: recording manifest
  const manifestPath = path.join(recordingDir, "recording_manifest.json");
  const manifestData = {
    fps,
    frameCount: files.length,
    durationSeconds,
    formatRequested: format,
    frames: files,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));

  return {
    success: true,
    videoPath: manifestPath,
    format: "manifest",
    durationSeconds,
    cleanedFrames: false,
    compilerUsed: "manifest_fallback",
  };
}
