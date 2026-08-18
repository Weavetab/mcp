/**
 * Weavetab — tools/design_extract.ts
 * browser_extract_design: Extract design tokens, typography, color palette,
 * clean semantic HTML, and CSS from the current page into structured files
 * and a compact LLM design blueprint.
 *
 * Saves to configured designDir (e.g. ~/.weavetab/designs/ or custom workspace directory).
 *
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/loader.js";
import { getOutputDir } from "../config/loader.js";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";

export interface ExtractDesignOptions {
  /** CSS selector of the container to extract (default: 'main', falls back to 'body') */
  selector?: string;
  /** Format preset: 'tailwind' generates tailwind.theme.json, 'vanilla_css' generates scoped styles, 'tokens_only' extracts design tokens */
  format?: "tailwind" | "vanilla_css" | "tokens_only";
  /** Optional custom folder path to write extracted files into. If omitted, uses configured designDir */
  outputDir?: string;
  /** Optional custom name for the design bundle folder (e.g. 'resend-hero') */
  name?: string;
  /** Whether to capture SVG icons and image asset references (default: true) */
  includeAssets?: boolean;
  /** If false, keeps Weavetab overlay visible during capture (default: true -> hidden) */
  hideOverlay?: boolean;
}

export interface DesignTokens {
  meta: {
    url: string;
    title: string;
    extractedAt: string;
    selector: string;
    viewport: { width: number; height: number };
    isDarkMode: boolean;
  };
  cssVariables: Record<string, string>;
  palette: {
    backgrounds: string[];
    text: string[];
    borders: string[];
    accents: string[];
  };
  typography: {
    fontFamilies: string[];
    headings: Record<string, {
      fontFamily: string;
      fontSize: string;
      fontWeight: string;
      lineHeight: string;
      letterSpacing: string;
      color: string;
    }>;
    body: {
      fontFamily: string;
      fontSize: string;
      fontWeight: string;
      lineHeight: string;
      color: string;
    };
  };
  effects: {
    shadows: string[];
    radii: string[];
    backdropBlurs: string[];
  };
  layout: {
    displayTypes: string[];
    gapValues: string[];
    paddingValues: string[];
  };
}

/**
 * Pretty-print and format raw HTML with clean 2-space indentation and semantic readability.
 */
export function beautifyHtml(rawHtml: string): string {
  if (!rawHtml || !rawHtml.trim()) return "";

  // Normalize newlines and collapse excessive spaces
  let formatted = "";
  let indentLevel = 0;
  const indent = () => "  ".repeat(indentLevel);

  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
  ]);

  const inlineElements = new Set([
    "span", "a", "strong", "b", "em", "i", "code", "small", "kbd", "badge"
  ]);

  // Tokenize tags and text content
  const tokens: Array<{ type: "open" | "close" | "selfClose" | "text" | "comment"; tag?: string; content: string }> = [];
  const tagRegex = /<!--[\s\S]*?-->|<(?:"[^"]*"['"]*|'[^']*'['"]*|[^'">])+>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(rawHtml)) !== null) {
    if (match.index > lastIndex) {
      const text = rawHtml.substring(lastIndex, match.index).trim();
      if (text) {
        tokens.push({ type: "text", content: text });
      }
    }

    const tagStr = match[0];
    if (tagStr.startsWith("<!--")) {
      tokens.push({ type: "comment", content: tagStr });
    } else if (tagStr.startsWith("</")) {
      const tagNameMatch = tagStr.match(/<\/([a-zA-Z0-9:-]+)/);
      const tag = tagNameMatch ? tagNameMatch[1].toLowerCase() : "";
      tokens.push({ type: "close", tag, content: tagStr });
    } else {
      const tagNameMatch = tagStr.match(/<([a-zA-Z0-9:-]+)/);
      const tag = tagNameMatch ? tagNameMatch[1].toLowerCase() : "";
      const isSelfClosing = tagStr.endsWith("/>") || voidElements.has(tag);
      tokens.push({
        type: isSelfClosing ? "selfClose" : "open",
        tag,
        content: tagStr
      });
    }

    lastIndex = tagRegex.lastIndex;
  }

  if (lastIndex < rawHtml.length) {
    const text = rawHtml.substring(lastIndex).trim();
    if (text) {
      tokens.push({ type: "text", content: text });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "open") {
      // Check for compact single-line elements (e.g. <h1>Title</h1> or <a href="...">Link</a>)
      const next1 = tokens[i + 1];
      const next2 = tokens[i + 2];
      const isCompact = next1 && next1.type === "text" && next2 && next2.type === "close" && next2.tag === token.tag && next1.content.length < 80;

      if (isCompact) {
        formatted += `${indent()}${token.content}${next1.content}${next2.content}\n`;
        i += 2; // Skip text and close tag
      } else {
        formatted += `${indent()}${token.content}\n`;
        indentLevel++;
      }
    } else if (token.type === "close") {
      indentLevel = Math.max(0, indentLevel - 1);
      formatted += `${indent()}${token.content}\n`;
    } else if (token.type === "selfClose" || token.type === "comment") {
      formatted += `${indent()}${token.content}\n`;
    } else if (token.type === "text") {
      formatted += `${indent()}${token.content}\n`;
    }
  }

  return formatted.trim() + "\n";
}

export async function browserExtractDesign(
  session: CDP.Client,
  options: ExtractDesignOptions = {},
  config: Config
): Promise<{
  success: boolean;
  data: {
    outputDirectory: string;
    files: {
      tokens: string;
      html?: string;
      css?: string;
      tailwind?: string;
      readme: string;
    };
    tokensSummary: {
      colors: {
        backgrounds: string[];
        text: string[];
        accents: string[];
        borders: string[];
      };
      fonts: string[];
      radii: string[];
      shadows: string[];
      cssVariablesCount: number;
    };
    htmlMetrics?: {
      nodeCount: number;
      svgCount: number;
      htmlBytes: number;
    };
  };
  message: string;
}> {
  const {
    selector = "main",
    format = "tailwind",
    outputDir: customOutputDir,
    name: customName,
    includeAssets = true,
    hideOverlay = true,
  } = options;

  if (hideOverlay) {
    await hideWeaveTabOverlay(session).catch(() => {});
  }

  try {
    const evalRes = await session.Runtime.evaluate({
      expression: `(function(targetSelector, includeAssetsFlag) {
        // Find target container
        let root = document.querySelector(targetSelector);
        if (!root && targetSelector !== 'body') {
          root = document.querySelector('body') || document.documentElement;
        }
        if (!root) root = document.documentElement;

        // ── 1. Meta & Environment ──
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          || document.documentElement.classList.contains('dark')
          || document.body?.classList.contains('dark')
          || (window.getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' || window.getComputedStyle(document.body).backgroundColor.startsWith('rgb(1') || window.getComputedStyle(document.body).backgroundColor.startsWith('rgb(2'));

        const meta = {
          url: window.location.href,
          title: document.title || '',
          extractedAt: new Date().toISOString(),
          selector: targetSelector,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          },
          isDarkMode: !!isDark
        };

        // ── 2. CSS Custom Properties (:root / html / body) ──
        const cssVars = {};
        const rootStyles = window.getComputedStyle(document.documentElement);
        const bodyStyles = document.body ? window.getComputedStyle(document.body) : null;

        // Extract declared variables from styleSheets
        Array.from(document.styleSheets).forEach(sheet => {
          try {
            Array.from(sheet.cssRules || []).forEach(rule => {
              if (rule.style && (rule.selectorText === ':root' || rule.selectorText === 'html' || rule.selectorText === 'body' || rule.selectorText === '.dark' || rule.selectorText === '[data-theme="dark"]')) {
                for (let i = 0; i < rule.style.length; i++) {
                  const propName = rule.style[i];
                  if (propName.startsWith('--')) {
                    const val = rootStyles.getPropertyValue(propName).trim() || (bodyStyles ? bodyStyles.getPropertyValue(propName).trim() : '');
                    if (val) cssVars[propName] = val;
                  }
                }
              }
            });
          } catch (_) {
            // CORS stylesheet security restriction — ignore
          }
        });

        // ── Helper: Color Parsing & Normalization ──
        function normalizeColor(c) {
          if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
          return c.trim();
        }

        // ── 3. Token Harvesters ──
        const bgColors = new Set();
        const textColors = new Set();
        const borderColors = new Set();
        const fontFamilies = new Set();
        const shadows = new Set();
        const radii = new Set();
        const blurs = new Set();
        const displayTypes = new Set();
        const gaps = new Set();
        const paddings = new Set();

        const headings = {};
        let bodyTypography = {
          fontFamily: '',
          fontSize: '',
          fontWeight: '',
          lineHeight: '',
          color: ''
        };

        if (document.body) {
          const bs = window.getComputedStyle(document.body);
          bodyTypography = {
            fontFamily: bs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
            fontSize: bs.fontSize,
            fontWeight: bs.fontWeight,
            lineHeight: bs.lineHeight,
            color: bs.color
          };
          if (bs.fontFamily) fontFamilies.add(bodyTypography.fontFamily);
        }

        // Collect heading styles
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
          const el = root.querySelector(tag);
          if (el) {
            const hs = window.getComputedStyle(el);
            headings[tag] = {
              fontFamily: hs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
              fontSize: hs.fontSize,
              fontWeight: hs.fontWeight,
              lineHeight: hs.lineHeight,
              letterSpacing: hs.letterSpacing,
              color: hs.color
            };
            if (hs.fontFamily) fontFamilies.add(headings[tag].fontFamily);
          }
        });

        let totalNodes = 0;
        let svgCount = 0;

        function walkTokens(node) {
          if (!node || node.nodeType !== 1) return;
          if (node.id === 'wt-shadow-host' || node.hasAttribute('data-wt-ignore')) return;

          totalNodes++;
          const tag = node.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'iframe'].includes(tag)) return;
          if (tag === 'svg') svgCount++;

          const s = window.getComputedStyle(node);
          if (s.display === 'none' || s.visibility === 'hidden') return;

          const bg = normalizeColor(s.backgroundColor);
          if (bg) bgColors.add(bg);

          const col = normalizeColor(s.color);
          if (col) textColors.add(col);

          const bc = normalizeColor(s.borderColor);
          if (bc && s.borderWidth !== '0px') borderColors.add(bc);

          if (s.fontFamily) {
            const f = s.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
            if (f && f !== 'inherit') fontFamilies.add(f);
          }

          if (s.boxShadow && s.boxShadow !== 'none') shadows.add(s.boxShadow);
          if (s.borderRadius && s.borderRadius !== '0px') radii.add(s.borderRadius);
          if (s.backdropFilter && s.backdropFilter !== 'none') blurs.add(s.backdropFilter);

          if (s.display) displayTypes.add(s.display);
          if (s.gap && s.gap !== 'normal' && s.gap !== '0px') gaps.add(s.gap);
          if (s.padding && s.padding !== '0px') paddings.add(s.padding);

          for (let i = 0; i < node.children.length; i++) {
            walkTokens(node.children[i]);
          }
        }

        walkTokens(root);

        // ── 4. Intelligent DOM Normalizer & Beautifier ──
        const clone = root.cloneNode(true);

        // A. Remove useless elements
        clone.querySelectorAll('script, style, noscript, iframe, link, #wt-shadow-host, [data-wt-ignore]').forEach(el => el.remove());

        // B. Handle Framer Motion / SplitText Spans & Hidden Duplicates
        function normalizeDomTree(el) {
          if (!el || el.nodeType !== 1) return;

          const tag = el.tagName.toLowerCase();

          // 1. Check for visually hidden / aria-hidden text duplication (Linear / Framer Motion pattern)
          const srOnlyEl = el.querySelector('.visuallyHidden, [class*="visuallyHidden"], .sr-only, [class*="sr-only"]');
          const ariaHiddenEl = el.querySelector('[aria-hidden="true"]');
          if (srOnlyEl && (ariaHiddenEl || el.querySelectorAll('span').length > 2)) {
            const canonicalText = srOnlyEl.textContent.trim();
            if (canonicalText) {
              el.innerHTML = canonicalText;
            }
          } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'button', 'a'].includes(tag)) {
            // If all children are spans with fragmented text or animation styles, unsplit them
            const spans = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'span');
            const hasOtherContent = Array.from(el.children).some(c => !['span', 'br', 'wbr'].includes(c.tagName.toLowerCase()));
            
            if (spans.length >= 2 && !hasOtherContent) {
              // Check if spans have duplicate text due to responsive breakpoints (e.g. show-mobile vs hide-mobile)
              const mobileSpans = spans.filter(s => s.className && s.className.includes('mobile'));
              const hideMobileSpans = spans.filter(s => s.className && s.className.includes('hide-mobile'));
              
              if (hideMobileSpans.length > 0) {
                // Desktop active: keep hide-mobile / remove show-mobile
                mobileSpans.filter(s => s.className.includes('show-mobile')).forEach(s => s.remove());
              }
              
              // If remaining spans are just split words, join them cleanly
              const remainingSpans = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'span');
              const textContent = remainingSpans.map(s => s.textContent).join(' ').replace(/\\s+/g, ' ').trim();
              if (textContent) {
                el.innerHTML = textContent;
              }
            }
          }

          // 2. Clean inline styles (remove animation / matrix / opacity: 1 fluff)
          if (el.hasAttribute('style')) {
            const rawStyle = el.getAttribute('style') || '';
            const meaningfulStyles = [];
            
            rawStyle.split(';').forEach(rule => {
              const trimmed = rule.trim();
              if (!trimmed) return;
              const [prop, val] = trimmed.split(':').map(s => s.trim());
              if (!prop || !val) return;
              
              // Skip animation artifacts
              if (
                (prop === 'opacity' && val === '1') ||
                (prop === 'filter' && (val === 'blur(0px)' || val === 'none')) ||
                (prop === 'transform' && (val.includes('translateY(0%)') || val.includes('translate3d(0, 0, 0)') || val === 'none' || val.includes('matrix(1, 0, 0, 1, 0, 0)'))) ||
                (prop === 'will-change') ||
                (prop === 'perspective') ||
                (prop === 'backface-visibility')
              ) {
                return;
              }

              // Keep intentional layout styles / CSS variables / spacer heights
              if (prop.startsWith('--height') || prop === 'height') {
                meaningfulStyles.push('height: ' + val);
              } else if (prop.startsWith('--gap') || prop === 'gap') {
                meaningfulStyles.push('gap: ' + val);
              } else if (!prop.startsWith('--')) {
                meaningfulStyles.push(prop + ': ' + val);
              }
            });

            if (meaningfulStyles.length > 0) {
              el.setAttribute('style', meaningfulStyles.join('; '));
            } else {
              el.removeAttribute('style');
            }
          }

          // 3. Clean and normalize class names (strip random hashes, keep semantic names)
          if (el.hasAttribute('class')) {
            const rawClasses = (el.getAttribute('class') || '').split(/\\s+/);
            const cleanClasses = [];

            rawClasses.forEach(cls => {
              const c = cls.trim();
              if (!c) return;
              // Skip internal / ephemeral classes
              if (c.startsWith('sc-') || c === 'show-mobile' || c.startsWith('wt-')) return;
              
              // De-hash CSS module names: e.g. "ImRUSq_justify-space-between" -> "justify-between"
              if (c.includes('_')) {
                const parts = c.split('_');
                const semanticPart = parts[parts.length - 1];
                if (semanticPart && semanticPart.length > 2 && !semanticPart.match(/^[a-f0-9]{4,}$/i)) {
                  let normalized = semanticPart
                    .replace('justify-space-between', 'justify-between')
                    .replace('align-center', 'items-center');
                  if (normalized === 'root') normalized = 'spacer';
                  cleanClasses.push(normalized);
                  return;
                }
              }

              // Keep standard semantic / utility class
              cleanClasses.push(c);
            });

            const uniqueClasses = Array.from(new Set(cleanClasses));
            if (uniqueClasses.length > 0) {
              el.setAttribute('class', uniqueClasses.join(' '));
            } else {
              el.removeAttribute('class');
            }
          }

          // 4. Remove internal / framework attributes
          ['data-wt-id', 'data-wt-secret', 'jsaction', 'jscontroller', 'jsname', 'jsmodel', 'data-sentry-component', 'data-sentry-source-file'].forEach(attr => {
            el.removeAttribute(attr);
          });

          // 5. Clean SVGs
          if (el.tagName.toLowerCase() === 'svg' && !includeAssetsFlag) {
            el.innerHTML = '<!-- svg icon -->';
          }

          // Recurse children
          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i++) {
            normalizeDomTree(children[i]);
          }

          // 6. Remove empty spacer divs with no styles or classes
          if (tag === 'div' && el.children.length === 0 && !el.textContent.trim() && !el.hasAttribute('style') && !el.hasAttribute('class')) {
            el.remove();
          }
        }

        normalizeDomTree(clone);

        // ── 5. Full Real CSS Extraction ──
        const collectedStyleBlocks = [];
        const keyframeMap = new Map();
        const mediaQueryMap = new Map();
        const fontFaceList = [];
        const classRules = [];

        // A. Extract all <style> tags (includes Tailwind, Emotion, styled-components, Next.js CSS)
        document.querySelectorAll('style').forEach(st => {
          const text = (st.textContent || '').trim();
          if (text) {
            collectedStyleBlocks.push(text);
          }
        });

        // B. Extract accessible CSS rules from document.styleSheets
        Array.from(document.styleSheets).forEach(sheet => {
          try {
            Array.from(sheet.cssRules || []).forEach(rule => {
              const ruleText = rule.cssText;
              if (!ruleText) return;

              if (rule.type === 7 || rule.constructor.name === 'CSSKeyframesRule') {
                keyframeMap.set(rule.name || ruleText.slice(0, 30), ruleText);
              } else if (rule.type === 5 || rule.constructor.name === 'CSSFontFaceRule') {
                fontFaceList.push(ruleText);
              } else if (rule.type === 4 || rule.constructor.name === 'CSSMediaRule') {
                mediaQueryMap.set(rule.conditionText || ruleText.slice(0, 30), ruleText);
              } else if (rule.style) {
                const sel = rule.selectorText || '';
                if (sel && !sel.includes('wt-') && !sel.includes('chrome-extension')) {
                  classRules.push(ruleText);
                }
              }
            });
          } catch (_) {
            // Cross-origin stylesheet security restriction — ignored
          }
        });

        // C. Build formatted comprehensive styles.css
        let fullCss = '/* ==========================================================================\\n';
        fullCss += '   Design Blueprint Stylesheet: ' + (document.title || window.location.hostname) + '\\n';
        fullCss += '   Extracted via Weavetab browser_extract_design\\n';
        fullCss += '   ========================================================================== */\\n\\n';

        // 1. CSS Custom Properties
        fullCss += '/* ── 1. CSS Custom Properties (:root / themes) ── */\\n:root {\\n';
        Object.entries(cssVars).forEach(([k, v]) => {
          fullCss += '  ' + k + ': ' + v + ';\\n';
        });
        fullCss += '}\\n\\n';

        // 2. Font Faces
        if (fontFaceList.length > 0) {
          fullCss += '/* ── 2. Font Faces ── */\\n';
          Array.from(new Set(fontFaceList)).slice(0, 10).forEach(ff => {
            fullCss += ff + '\\n\\n';
          });
        }

        // 3. Keyframe Animations
        if (keyframeMap.size > 0) {
          fullCss += '/* ── 3. Keyframe Animations ── */\\n';
          Array.from(keyframeMap.values()).forEach(kf => {
            fullCss += kf + '\\n\\n';
          });
        }

        // 4. Stylesheet Rules / Style Blocks
        fullCss += '/* ── 4. Layout & Component Styles ── */\\n';
        if (collectedStyleBlocks.length > 0) {
          collectedStyleBlocks.forEach(sb => {
            fullCss += sb + '\\n\\n';
          });
        } else if (classRules.length > 0) {
          Array.from(new Set(classRules)).forEach(cr => {
            fullCss += cr + '\\n';
          });
        }

        // 5. Responsive Media Queries
        if (mediaQueryMap.size > 0 && collectedStyleBlocks.length === 0) {
          fullCss += '\\n/* ── 5. Responsive Media Queries ── */\\n';
          Array.from(mediaQueryMap.values()).forEach(mq => {
            fullCss += mq + '\\n\\n';
          });
        }

        return {
          tokens: {
            meta,
            cssVariables: cssVars,
            palette: {
              backgrounds: Array.from(bgColors).slice(0, 25),
              text: Array.from(textColors).slice(0, 20),
              borders: Array.from(borderColors).slice(0, 15),
              accents: Array.from(bgColors).filter(c => !c.includes('255, 255, 255') && !c.includes('0, 0, 0') && !c.includes('rgba(0, 0, 0')).slice(0, 10)
            },
            typography: {
              fontFamilies: Array.from(fontFamilies),
              headings,
              body: bodyTypography
            },
            effects: {
              shadows: Array.from(shadows).slice(0, 10),
              radii: Array.from(radii).slice(0, 10),
              backdropBlurs: Array.from(blurs).slice(0, 5)
            },
            layout: {
              displayTypes: Array.from(displayTypes),
              gapValues: Array.from(gaps).slice(0, 10),
              paddingValues: Array.from(paddings).slice(0, 10)
            }
          },
          rawHtml: clone.outerHTML,
          css: fullCss,
          metrics: {
            nodeCount: totalNodes,
            svgCount,
            htmlBytes: clone.outerHTML.length
          }
        };
      })(${JSON.stringify(selector)}, ${JSON.stringify(includeAssets)})`,
      returnByValue: true
    });

    const result = evalRes.result?.value;
    if (!result || !result.tokens) {
      throw new Error(`Failed to extract design from selector '${selector}'`);
    }

    const { tokens, rawHtml, css, metrics } = result as {
      tokens: DesignTokens;
      rawHtml: string;
      css: string;
      metrics: { nodeCount: number; svgCount: number; htmlBytes: number };
    };

    // ── Prettify and Format HTML ──
    const beautifulHtml = beautifyHtml(rawHtml);

    // ── Output Directory Resolution ──
    let targetDir: string;
    if (customOutputDir && customOutputDir.trim()) {
      targetDir = path.isAbsolute(customOutputDir.trim())
        ? customOutputDir.trim()
        : path.resolve(process.cwd(), customOutputDir.trim());
    } else {
      const baseDesignsDir = getOutputDir("designs", config);
      let folderName = customName ? customName.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
      if (!folderName) {
        let domain = "page";
        try {
          const parsed = new URL(tokens.meta.url);
          domain = parsed.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
        } catch (_) {}
        folderName = `${domain}-${Date.now()}`;
      }
      targetDir = path.join(baseDesignsDir, folderName);
    }

    await fs.mkdir(targetDir, { recursive: true });

    // ── Generate Files ──
    const tokensPath = path.join(targetDir, "tokens.json");
    await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2), "utf-8");

    const htmlPath = path.join(targetDir, "template.html");
    await fs.writeFile(htmlPath, beautifulHtml, "utf-8");

    const cssPath = path.join(targetDir, "styles.css");
    await fs.writeFile(cssPath, css, "utf-8");

    // Generate Tailwind Theme Extension if requested
    let tailwindPath: string | undefined;
    if (format === "tailwind") {
      const tailwindTheme = {
        theme: {
          extend: {
            colors: {
              ...tokens.palette.backgrounds.reduce((acc, c, i) => ({ ...acc, [`extracted-bg-${i + 1}`]: c }), {}),
              ...tokens.palette.accents.reduce((acc, c, i) => ({ ...acc, [`extracted-accent-${i + 1}`]: c }), {}),
            },
            fontFamily: {
              ...tokens.typography.fontFamilies.reduce((acc, f, i) => {
                const key = f.toLowerCase().replace(/[^a-z0-9]/g, '');
                return { ...acc, [key || `font-${i + 1}`]: [f, "sans-serif"] };
              }, {})
            },
            borderRadius: {
              ...tokens.effects.radii.reduce((acc, r, i) => ({ ...acc, [`extracted-r-${i + 1}`]: r }), {})
            },
            boxShadow: {
              ...tokens.effects.shadows.reduce((acc, s, i) => ({ ...acc, [`extracted-shadow-${i + 1}`]: s }), {})
            }
          }
        }
      };
      tailwindPath = path.join(targetDir, "tailwind.theme.json");
      await fs.writeFile(tailwindPath, JSON.stringify(tailwindTheme, null, 2), "utf-8");
    }

    // Generate Markdown README Guide for AI Agent
    const readmePath = path.join(targetDir, "README.md");
    const readmeContent = `# Design Blueprint: ${tokens.meta.title || tokens.meta.url}

- **Extracted At**: ${tokens.meta.extractedAt}
- **Source URL**: ${tokens.meta.url}
- **Theme**: ${tokens.meta.isDarkMode ? "Dark Mode" : "Light Mode"}
- **Selector**: \`${tokens.meta.selector}\`

## Design System Tokens
- **Font Families**: ${tokens.typography.fontFamilies.join(", ") || "System Default"}
- **Primary Background Colors**: \`${tokens.palette.backgrounds.slice(0, 5).join("`, `")}\`
- **Text Colors**: \`${tokens.palette.text.slice(0, 5).join("`, `")}\`
- **Border Radii**: \`${tokens.effects.radii.slice(0, 5).join("`, `")}\`
- **Shadows**: ${tokens.effects.shadows.length} extracted shadow styles

## Included Files
1. \`tokens.json\` — Full machine-readable design tokens, CSS variables, typography hierarchy, and colors.
2. \`template.html\` — Clean, semantic, beautified HTML skeleton (${metrics.nodeCount} elements, ${metrics.svgCount} SVGs).
3. \`styles.css\` — Extracted CSS variables and scoped styles.
${tailwindPath ? "4. `tailwind.theme.json` — Tailwind CSS `theme.extend` configuration.\n" : ""}
## Agent Implementation Instructions
- Open \`tokens.json\` to copy exact hex colors, typography weights, and border radius tokens.
- Open \`template.html\` to review semantic structure, SVGs, and component layout hierarchy.
- Recreate the target component in your project using these exact tokens.
`;
    await fs.writeFile(readmePath, readmeContent, "utf-8");

    return {
      success: true,
      data: {
        outputDirectory: targetDir,
        files: {
          tokens: tokensPath,
          html: htmlPath,
          css: cssPath,
          tailwind: tailwindPath,
          readme: readmePath,
        },
        tokensSummary: {
          colors: tokens.palette,
          fonts: tokens.typography.fontFamilies,
          radii: tokens.effects.radii,
          shadows: tokens.effects.shadows,
          cssVariablesCount: Object.keys(tokens.cssVariables).length
        },
        htmlMetrics: {
          nodeCount: metrics.nodeCount,
          svgCount: metrics.svgCount,
          htmlBytes: beautifulHtml.length
        }
      },
      message: `Design extracted successfully to ${targetDir}. Saved tokens.json, template.html, styles.css, and README.md.`
    };
  } finally {
    if (hideOverlay) {
      await restoreWeaveTabOverlay(session).catch(() => {});
    }
  }
}
