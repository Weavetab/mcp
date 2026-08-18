/**
 * Verification helper functions for DOM state confirmation
 * Provides utilities to verify element state, detect visible feedback, and infer next actions
 */

import CDP from "chrome-remote-interface";

export interface ElementState {
  exists: boolean;
  tagName?: string;
  value?: string;
  textContent?: string;
  checked?: boolean;
  disabled?: boolean;
  visible?: boolean;
  attributes?: Record<string, string>;
  className?: string;
}

export interface VisibleFeedback {
  type: 'error' | 'warning' | 'success' | 'info';
  text: string;
  selector?: string;
}

/**
 * Read full element state for verification
 * Returns comprehensive state snapshot for before/after comparison
 */
export async function verifyElementState(
  session: CDP.Client,
  selector: string
): Promise<ElementState> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        try {
          var el = document.querySelector(sel);
          if (!el) return JSON.stringify({ exists: false });
          
          var rect = el.getBoundingClientRect();
          var attrs = {};
          for (var i = 0; i < el.attributes.length; i++) {
            attrs[el.attributes[i].name] = el.attributes[i].value;
          }
          
          return JSON.stringify({
            exists: true,
            tagName: el.tagName.toLowerCase(),
            value: (el as any).value !== undefined ? String((el as any).value) : undefined,
            textContent: el.textContent ? el.textContent.slice(0, 200) : undefined,
            checked: (el as any).checked,
            disabled: (el as any).disabled,
            visible: rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight,
            attributes: attrs,
            className: el.className
          });
        } catch(e) {
          return JSON.stringify({ exists: false, error: (e as Error).message });
        }
      })(${JSON.stringify(selector)})`,
      returnByValue: true,
    });
    return (result?.value as ElementState) || { exists: false };
  } catch {
    return { exists: false };
  }
}

/**
 * Detect visible feedback messages (toasts, errors, validation messages)
 * Scans common selectors for feedback elements
 */
export async function detectVisibleFeedback(
  session: CDP.Client
): Promise<VisibleFeedback[]> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: (function() {
        var feedback = [];
        var selectors = [
          '[role="alert"]', '[role="status"]', '[role="error"]',
          '.error', '.warning', '.success', '.info',
          '[class*="error"]', '[class*="warning"]', '[class*="success"]',
          '[class*="toast"]', '[class*="notification"]',
          '[data-testid*="error"]', '[data-testid*="message"]'
        ];
        
        for (var i = 0; i < selectors.length; i++) {
          var els = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight) {
              var text = el.textContent || (el as HTMLElement).innerText || '';
              if (text.trim()) {
                var type = 'info';
                if (el.className.includes('error') || el.getAttribute('role') === 'error') type = 'error';
                else if (el.className.includes('warning')) type = 'warning';
                else if (el.className.includes('success')) type = 'success';
                
                feedback.push({
                  type: type,
                  text: text.trim().slice(0, 200),
                  selector: selectors[i]
                });
              }
            }
          }
        }
        
        return JSON.stringify(feedback.slice(0, 5)); // Limit to 5 most recent
      })(),
      returnByValue: true,
    });
    return (result?.value as VisibleFeedback[]) || [];
  } catch {
    return [];
  }
}

/**
 * Infer likely next action based on page context
 * Analyzes page state to suggest what the agent should do next
 */
export async function inferNextAction(
  session: CDP.Client,
  lastAction: string,
  context?: { filledFields?: string[]; clickedElement?: string }
): Promise<string | undefined> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `
        (function(lastAction, ctx) {
          try {
            var suggestions = [];
            if (lastAction === 'fill' || lastAction === 'type') {
              var inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select[required]');
              var emptyRequired = [];
              for (var i = 0; i < inputs.length; i++) {
                var inp = inputs[i];
                if ((inp.required || inp.getAttribute('aria-required') === 'true') && !inp.value) {
                  emptyRequired.push(inp.getAttribute('placeholder') || inp.getAttribute('name') || inp.getAttribute('aria-label') || 'field');
                }
              }
              if (emptyRequired.length > 0) {
                suggestions.push('Fill required field: ' + emptyRequired[0]);
              }
              var submitBtn = document.querySelector('button[type="submit"], input[type="submit"], [type="submit"]');
              if (submitBtn) {
                suggestions.push('Submit form');
              }
            }
            if (lastAction === 'click') {
              var modal = document.querySelector('[role="dialog"], .modal, [class*="modal"]');
              if (modal) {
                suggestions.push('Interact with modal dialog');
              }
            }
            return JSON.stringify(suggestions[0] || undefined);
          } catch(e) {
            return JSON.stringify(undefined);
          }
        })(${JSON.stringify(lastAction)}, ${JSON.stringify(context)})
      `,
      returnByValue: true,
    });
    return result?.value as string | undefined;
  } catch {
    return undefined;
  }
}
