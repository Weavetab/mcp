/**
 * Intent resolution system for interaction tools
 * Classifies targets and determines optimal interaction strategies before dispatch
 */

import CDP from "chrome-remote-interface";

export interface TargetClassification {
  /** Element type (button, input, link, etc.) */
  type: string;
  /** What interaction is semantically expected */
  interactionExpected: 'click' | 'type' | 'select' | 'check' | 'upload' | 'scroll';
  /** Likely success condition */
  successCondition: string;
  /** Fallback strategies if primary fails */
  fallbackStrategies: string[];
  /** Whether this is a React/Vue controlled component */
  isControlled: boolean;
  /** Estimated complexity (simple/complex) */
  complexity: 'simple' | 'complex';
}

// Simple in-memory cache for classification results
const classificationCache = new Map<string, { classification: TargetClassification; timestamp: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds
const CACHE_MAX_SIZE = 500;  // hard cap to prevent unbounded growth

// Stale entries are checked on read, but a background sweep removes expired
// entries every 60 s and a max-size cap (evict oldest first) keeps the cache
// from growing without bound even for keys that are never looked up again.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of classificationCache.entries()) {
    if (now - v.timestamp >= CACHE_TTL_MS) classificationCache.delete(k);
  }
}, 60_000).unref(); // .unref() so this interval never prevents process exit

/**
 * Classify a target element to determine optimal interaction strategy
 * Cheap (1 CDP call) classification that caches results per element
 */
export async function classifyTarget(
  session: CDP.Client,
  selector: string
): Promise<TargetClassification> {
  // Check cache first
  const cacheKey = ((session as any).target?.targetId || 'default') + ":" + selector;
  const cached = classificationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.classification;
  }

  // Enforce max-size cap before inserting a new entry (evict oldest)
  if (classificationCache.size >= CACHE_MAX_SIZE) {
    const firstKey = classificationCache.keys().next().value;
    if (firstKey !== undefined) classificationCache.delete(firstKey);
  }

  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        try {
          var el = document.querySelector(sel);
          if (!el) return JSON.stringify({ error: 'not_found' });
          
          var tag = el.tagName.toLowerCase();
          var typeAttr = (el.getAttribute('type') || 'text').toLowerCase();
          var role = el.getAttribute('role') || '';
          var isControlled = false;
          
          // Detect React/Vue controlled components
          if ((el as any)._reactInternalFiber || (el as any)._reactRootContainer || 
              (el as any).__vueApp__ || (el as any).__VUE__ || 
              el.hasAttribute('data-reactroot')) {
            isControlled = true;
          }
          
          var classification: any = {
            type: tag,
            interactionExpected: 'click',
            successCondition: 'element_clicked',
            fallbackStrategies: [],
            isControlled: isControlled,
            complexity: 'simple'
          };
          
          // Determine interaction type based on element
          if (tag === 'input') {
            if (typeAttr === 'checkbox' || typeAttr === 'radio') {
              classification.interactionExpected = 'check';
              classification.successCondition = 'checked_state_changed';
              classification.fallbackStrategies = ['click', 'property_set'];
            } else if (typeAttr === 'file') {
              classification.interactionExpected = 'upload';
              classification.successCondition = 'file_selected';
              classification.fallbackStrategies = ['click', 'direct_upload'];
            } else if (typeAttr === 'submit' || typeAttr === 'button') {
              classification.interactionExpected = 'click';
              classification.successCondition = 'form_submitted_or_clicked';
              classification.fallbackStrategies = ['click', 'form_submit'];
            } else {
              classification.interactionExpected = 'type';
              classification.successCondition = 'value_changed';
              classification.fallbackStrategies = ['native_setter', 'react_setter', 'dispatch_events'];
              classification.complexity = isControlled ? 'complex' : 'simple';
            }
          } else if (tag === 'textarea') {
            classification.interactionExpected = 'type';
            classification.successCondition = 'value_changed';
            classification.fallbackStrategies = ['native_setter', 'react_setter', 'dispatch_events'];
            classification.complexity = isControlled ? 'complex' : 'simple';
          } else if (tag === 'select') {
            classification.interactionExpected = 'select';
            classification.successCondition = 'selection_changed';
            classification.fallbackStrategies = ['property_set', 'click_option'];
            classification.complexity = isControlled ? 'complex' : 'simple';
          } else if (tag === 'button' || role === 'button') {
            classification.interactionExpected = 'click';
            classification.successCondition = 'clicked';
            classification.fallbackStrategies = ['click', 'keyboard_enter'];
          } else if (tag === 'a') {
            classification.interactionExpected = 'click';
            classification.successCondition = 'navigated';
            classification.fallbackStrategies = ['click', 'direct_navigate'];
          } else if (tag === 'div' || tag === 'span') {
            if (role === 'textbox' || role === 'combobox' || (el as any).isContentEditable) {
              classification.interactionExpected = 'type';
              classification.successCondition = 'text_changed';
              classification.fallbackStrategies = ['text_content_set', 'dispatch_events'];
              classification.complexity = 'complex';
            } else {
              classification.interactionExpected = 'click';
              classification.successCondition = 'clicked';
              classification.fallbackStrategies = ['click'];
            }
          }
          
          return JSON.stringify(classification);
        } catch(e) {
          return JSON.stringify({ error: (e as Error).message });
        }
      })(${JSON.stringify(selector)})`,
      returnByValue: true,
    });
    
    const classification = result?.value as any;
    
    // Cache the result
    if (classification && !classification.error) {
      classificationCache.set(cacheKey, { classification, timestamp: Date.now() });
    }
    
    return classification as TargetClassification;
  } catch (error) {
    // Return safe default on error
    return {
      type: 'unknown',
      interactionExpected: 'click',
      successCondition: 'clicked',
      fallbackStrategies: ['click'],
      isControlled: false,
      complexity: 'simple'
    };
  }
}

/**
 * Clear classification cache for a specific target or all targets
 */
export function clearClassificationCache(selector?: string): void {
  if (selector) {
    // Clear specific selector entries
    for (const [key] of classificationCache) {
      if (key.endsWith(":" + selector)) {
        classificationCache.delete(key);
      }
    }
  } else {
    // Clear all cache
    classificationCache.clear();
  }
}

/**
 * Get optimal strategy based on classification
 * Returns the best strategy to try first
 */
export function getOptimalStrategy(classification: TargetClassification): string {
  // For controlled components, prefer React-specific strategies
  if (classification.isControlled) {
    if (classification.interactionExpected === 'type') {
      return 'react_setter';
    }
  }
  
  // Default to first fallback strategy
  return classification.fallbackStrategies[0] || classification.interactionExpected;
}
