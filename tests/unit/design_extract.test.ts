import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getOutputDir, getDesignDir, DEFAULT_CONFIG } from "../../src/config/loader.js";
import { browserExtractDesign, beautifyHtml } from "../../src/tools/design_extract.js";

test("designDir - default and custom path resolution", () => {
  const defaultDir = getOutputDir("designs", DEFAULT_CONFIG);
  assert.ok(defaultDir.endsWith(path.join(".weavetab", "designs")) || defaultDir.includes("designs"));

  const customConfig = {
    ...DEFAULT_CONFIG,
    designDir: path.join(os.tmpdir(), "custom-designs-dir")
  };
  const resolvedCustom = getOutputDir("designs", customConfig);
  assert.equal(resolvedCustom, path.join(os.tmpdir(), "custom-designs-dir"));
  assert.equal(getDesignDir(customConfig), path.join(os.tmpdir(), "custom-designs-dir"));
});

test("beautifyHtml - formats nested HTML and preserves compact tags", () => {
  const uglyHtml = '<main class="container"><h1 class="title">The product system</h1><div class="card"><p>Purpose-built for planning.</p><a href="/link" class="btn"><span>Click me</span></a></div></main>';
  const clean = beautifyHtml(uglyHtml);

  assert.ok(clean.includes("<main class=\"container\">"));
  assert.ok(clean.includes("  <h1 class=\"title\">The product system</h1>"));
  assert.ok(clean.includes("  <div class=\"card\">"));
  assert.ok(clean.includes("    <p>Purpose-built for planning.</p>"));
});

test("browserExtractDesign - mock session extraction & file output", async () => {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "wt-design-test-"));

  try {
    const mockSession: any = {
      Runtime: {
        evaluate: async () => ({
          result: {
            value: {
              tokens: {
                meta: {
                  url: "https://example.com/test",
                  title: "Example Test Page",
                  extractedAt: new Date().toISOString(),
                  selector: "main",
                  viewport: { width: 1280, height: 800 },
                  isDarkMode: true
                },
                cssVariables: {
                  "--background": "#0a0a0a",
                  "--primary": "#3b82f6"
                },
                palette: {
                  backgrounds: ["#0a0a0a", "#171717"],
                  text: ["#ffffff", "#a1a1aa"],
                  borders: ["#27272a"],
                  accents: ["#3b82f6"]
                },
                typography: {
                  fontFamilies: ["Inter", "sans-serif"],
                  headings: {
                    h1: {
                      fontFamily: "Inter",
                      fontSize: "36px",
                      fontWeight: "700",
                      lineHeight: "40px",
                      letterSpacing: "-0.02em",
                      color: "#ffffff"
                    }
                  },
                  body: {
                    fontFamily: "Inter",
                    fontSize: "16px",
                    fontWeight: "400",
                    lineHeight: "24px",
                    color: "#a1a1aa"
                  }
                },
                effects: {
                  shadows: ["0 4px 6px -1px rgba(0, 0, 0, 0.1)"],
                  radii: ["8px", "12px"],
                  backdropBlurs: ["blur(12px)"]
                },
                layout: {
                  displayTypes: ["flex", "grid"],
                  gapValues: ["16px", "24px"],
                  paddingValues: ["16px", "32px"]
                }
              },
              rawHtml: "<main class=\"flex flex-col gap-4\"><h1 class=\"text-3xl\">Example</h1><p>Test content</p></main>",
              css: ":root { --background: #0a0a0a; }",
              metrics: {
                nodeCount: 12,
                svgCount: 2,
                htmlBytes: 120
              }
            }
          }
        })
      }
    };

    const res = await browserExtractDesign(
      mockSession,
      {
        selector: "main",
        format: "tailwind",
        outputDir: tmpOut,
        hideOverlay: false
      },
      DEFAULT_CONFIG
    );

    assert.equal(res.success, true);
    assert.equal(res.data.outputDirectory, tmpOut);
    assert.ok(fs.existsSync(res.data.files.tokens));
    assert.ok(fs.existsSync(res.data.files.html!));
    assert.ok(fs.existsSync(res.data.files.css!));
    assert.ok(fs.existsSync(res.data.files.tailwind!));
    assert.ok(fs.existsSync(res.data.files.readme));

    const tokensContent = JSON.parse(fs.readFileSync(res.data.files.tokens, "utf-8"));
    assert.equal(tokensContent.meta.title, "Example Test Page");
    assert.equal(tokensContent.palette.backgrounds[0], "#0a0a0a");

    const tailwindContent = JSON.parse(fs.readFileSync(res.data.files.tailwind!, "utf-8"));
    assert.ok(tailwindContent.theme.extend.colors);

    const htmlContent = fs.readFileSync(res.data.files.html!, "utf-8");
    assert.ok(htmlContent.includes("<main class=\"flex flex-col gap-4\">"));
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});
