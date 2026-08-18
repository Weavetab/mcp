import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import sharp from "sharp";
import { compileVideo } from "../../src/tools/video_compiler.js";

test("video_compiler - pure Node compilation with sharp", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-rec-test-"));

  try {
    // Generate 3 sample frame images
    for (let i = 1; i <= 3; i++) {
      const buf = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: i * 80, g: 100, b: 200 },
        },
      })
        .jpeg()
        .toBuffer();

      const fname = `frame-${String(i).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(tmpDir, fname), buf);
    }

    // Compile into WebP animation using pure Node sharp compiler
    const result = await compileVideo({
      recordingDir: tmpDir,
      fps: 2,
      format: "webp",
      keepFrames: false,
    });

    assert.equal(result.success, true);
    assert.equal(result.format, "webp");
    assert.equal(result.compilerUsed, "sharp_pure_node");
    assert.ok(result.videoPath);
    assert.ok(fs.existsSync(result.videoPath));
    assert.ok(result.fileSizeBytes! > 0);

    // Verify raw frames were cleaned up as keepFrames was false
    const remainingJpegs = fs.readdirSync(tmpDir).filter(f => f.endsWith(".jpg"));
    assert.equal(remainingJpegs.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
