/**
 * Weavetab — tools/type_secret.ts
 * browser_type_secret: Securely injects a stored credential into a page input.
 *
 * Security model:
 *   - Secret value is resolved from JsonSecretStore (never process.env).
 *   - Domain enforcement: hard-fails if the current tab's hostname is not in the
 *     key's allowed domain list. This is the primary prompt-injection defense.
 *   - Value travels in-process only: secretStore → CDP Input.insertText.
 *     It is never returned in any tool_result, never logged, never trailed.
 *   - The DOM node is marked data-wt-secret so all subsequent read tools
 *     (browser_map, browser_scrape, browser_snapshot, delta) redact it.
 *   - Trail log records: key name + domain only, never value.
 *
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import { buildActionMap, findBestMatch, findAllMatches } from "../cdp/walker.js";
import { logAction } from "../audit/logger.js";
import { recordAction } from "../intelligence/trail.js";
import { SessionSecretTracker, secretStore } from "../security/secrets.js";
import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { sendToExtension } from "../cdp/helpers.js";

import { cacheActionMap, getCachedActionMap } from "../state/cache.js";

export async function weaveTypeSecret(
  session: CDP.Client,
  args: { id?: string; target?: string; envKey: string },
  config: Config
): Promise<any> {
  const startTime = Date.now();
  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  // ── Step 1: Resolve current tab domain ───────────────────────────────────
  const { Page } = session;
  const { frameTree } = await Page.getFrameTree();
  const url = frameTree.frame.url;

  let currentHostname: string;
  try {
    currentHostname = new URL(url).hostname;
  } catch {
    return {
      success: false,
      error_code: "INVALID_URL",
      message: `[!] Cannot determine current tab domain from URL: "${url}"`,
    };
  }

  // ── Step 2: Domain enforcement (prompt-injection defense) ─────────────────
  // This check is done BEFORE resolving the secret value.
  const allowedDomains = secretStore.getDomains(args.envKey);
  if (allowedDomains === null) {
    return {
      success: false,
      error_code: "SECRET_NOT_FOUND",
      message: `[!] Secret not found for key: "${args.envKey}". Run: Weavetab secrets set ${args.envKey}`,
    };
  }

  const domainAllowed = secretStore.checkDomain(args.envKey, currentHostname);
  if (!domainAllowed) {
    // Fail BEFORE touching the secret value — the value is never loaded.
    return {
      success: false,
      error_code: "DOMAIN_NOT_ALLOWED",
      message:
        `[!] Secret "${args.envKey}" is not scoped for domain "${currentHostname}". ` +
        (allowedDomains.length > 0
          ? `Allowed: [${allowedDomains.join(", ")}]. ` +
            `To add this domain: Weavetab secrets set ${args.envKey}`
          : `The allowed domain list is empty — add domains with: Weavetab secrets set ${args.envKey}`),
    };
  }

  // ── Step 3: Resolve secret value (in-process only from here) ──────────────
  const secretValue = await secretStore.getSecret(args.envKey);
  if (secretValue === undefined) {
    return {
      success: false,
      error_code: "SECRET_NOT_FOUND",
      message: `[!] Secret not found for key: "${args.envKey}"`,
    };
  }

  // ── Step 4: Build / cache action map ──────────────────────────────────────
  // Use cached map to prevent stale w: refs if the DOM hasn't changed.
  // The pruner's data-wt-secret guard fires on the element attribute, NOT the
  // id, so secret fields survive any preceding browser_map({ prune: true }) call.
  let map = getCachedActionMap(targetId, url);
  if (!map) {
    map = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, map);
  }
  const query = args.id || args.target;
  if (!query) {
    return { success: false, error_code: "INVALID_ARGS", message: "[!] Must provide id or target" };
  }

  let target = map.elements.find(el => el.id === query || el.id.endsWith(query.startsWith("w:") ? query.slice(2) : query));
  if (!target) {
    const matches = findAllMatches(map.elements, query);
    if (matches.length === 0) {
      return {
        success: false,
        error_code: "ELEMENT_NOT_FOUND",
        message: `[!] Could not find input matching "${query}"`,
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        error_code: "MULTIPLE_ELEMENTS_FOUND",
        message: `[!] Refusing to guess: found ${matches.length} matches for "${query}". Please use a more specific selector.`,
      };
    }
    target = matches[0];
  }

  const selector = target.selector || `[data-wt-id="${target.id}"]`;

  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `injecting [REDACTED]...` } });

  // ── Step 5: Resolve DOM node, mark as secret, focus ───────────────────────
  const nodeInfo = await session.Runtime.evaluate({
    expression: `(function(sel) {
      const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
      if (!el) throw new Error('NOT_FOUND');
      
      const tag = el.tagName.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
      if (!isEditable) throw new Error('NOT_EDITABLE');

      // Mark as secret so all subsequent read tools redact this element
      el.setAttribute('data-wt-secret', 'true');
      if (typeof el.select === 'function') { el.select(); }
      else if (el.isContentEditable) { el.textContent = ''; el.dispatchEvent(new Event('input',{bubbles:true})); }
      else { el.value = ''; el.dispatchEvent(new Event('input',{bubbles:true})); }
      
      return el;
    })(${JSON.stringify(selector)})`,
    returnByValue: false
  });

  if (nodeInfo.exceptionDetails) {
    const errMsg = nodeInfo.exceptionDetails.exception?.description || "";
    if (errMsg.includes('NOT_EDITABLE')) {
      return { success: false, error_code: "NOT_EDITABLE", message: `[!] Target ${selector} is not an editable field.` };
    }
    if (errMsg.includes('NOT_FOUND')) {
      return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Could not find element ${selector}.` };
    }
    return { success: false, error_code: "DOM_EVAL_FAILED", message: `[!] Evaluation failed while resolving target.` };
  }

  if (!nodeInfo.result?.objectId) {
    return { success: false, error_code: "DOM_RESOLUTION_FAILED", message: `[!] Failed to resolve DOM node for ${selector}` };
  }

  // Request node to get backendNodeId for SessionSecretTracker
  const nodeDetails = await session.DOM.requestNode({ objectId: nodeInfo.result.objectId });
  if (nodeDetails.nodeId) {
    const desc = await session.DOM.describeNode({ nodeId: nodeDetails.nodeId });
    if (desc.node.backendNodeId) {
      SessionSecretTracker.markNodeAsSecret(targetId, desc.node.backendNodeId);
    }
  }

  // ── Step 6: Focus element ─────────────────────────────────────────────────
  await session.Runtime.callFunctionOn({
    functionDeclaration: `function() {
      if (this.scrollIntoViewIfNeeded) this.scrollIntoViewIfNeeded();
      else this.scrollIntoView({behavior:'smooth',block:'center'});
      this.focus();
      this.click();
    }`,
    objectId: nodeInfo.result.objectId,
    silent: true
  });

  // ── Step 7: Inject secret via CDP insertText ───────────────────────────────
  // This is the ONLY point where secretValue is used.
  // It goes directly to CDP — never into any variable that could be returned.
  SessionSecretTracker.registerSecretValue(targetId, secretValue);
  await session.Input.insertText({ text: secretValue });

  // ── Step 7.5: Hardened Proxy & Shadow DOM Isolation ───────────────────────
  await session.Runtime.callFunctionOn({
    functionDeclaration: `function() {
      try {
        const el = this;
        // 1. Redact direct .value access
        const proto = Object.getPrototypeOf(el);
        const origDesc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (origDesc) {
          Object.defineProperty(el, 'value', {
            get: function() { return '[REDACTED]'; },
            set: origDesc.set,
            configurable: false,
            enumerable: true
          });
        }
        
        // 2. Defeat array spread, iteration, and coercion
        Object.defineProperty(el, Symbol.iterator, {
          value: function* () { yield '[REDACTED]'; },
          configurable: false
        });
        Object.defineProperty(el, Symbol.toPrimitive, {
          value: function() { return '[REDACTED]'; },
          configurable: false
        });
        // 2b. Defeat JSON.stringify and structuredClone data leaks
        Object.defineProperty(el, 'toJSON', {
          value: function() { return '[REDACTED]'; },
          configurable: false
        });
        
        // 3. Isolate in closed shadow DOM to prevent outer-world DOM traversal
        if (el.parentNode && !el.parentNode.shadowRoot) {
          const wrapper = document.createElement('div');
          wrapper.className = '__wt_secret_vault';
          // copy styles so layout doesn't break
          const compStyle = window.getComputedStyle(el);
          wrapper.style.display = compStyle.display === 'inline' ? 'inline-block' : compStyle.display;
          wrapper.style.width = compStyle.width;
          wrapper.style.height = compStyle.height;
          
          el.parentNode.insertBefore(wrapper, el);
          const shadow = wrapper.attachShadow({ mode: 'closed' });
          shadow.appendChild(el);
        }
      } catch (e) {
        // fail silently so as not to disrupt the page execution
      }
    }`,
    objectId: nodeInfo.result.objectId,
    silent: true
  });

  // Immediately zero out the local binding after use
  // (TypeScript doesn't guarantee this but it signals intent to reviewers)
  // secretValue = undefined; // can't reassign const — variable goes out of scope here

  const executionMs = Date.now() - startTime;

  // ── Step 8: Trail — key name + domain only, NEVER value ──────────────────
  const finalRef = target.id.startsWith('w:') ? target.id : `w:${target.id}`;
  logAction("browser_type_secret", finalRef, `[secret injected: ${args.envKey}@${currentHostname}] into ${target.label} (exec: ${executionMs}ms)`);
  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_type_secret",
    // input contains key name and domain ONLY — value is excluded intentionally
    input: { ref: finalRef, label: target.label, envKey: args.envKey, domain: currentHostname },
    result: { success: true },
  });

  // ── Step 9: Return — no secret value in result ────────────────────────────
  return {
    success: true,
    typed_into: target.label,
    ref: finalRef,
    key: args.envKey,
    domain: currentHostname,
    execution_ms: executionMs,
  };
}
