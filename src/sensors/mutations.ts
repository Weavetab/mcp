import CDP from "chrome-remote-interface";
import { Protocol } from "devtools-protocol";

export type MutationSummary = {
  newElements: { backendNodeId: number; tag: string; text: string; role?: string }[];
  removedElements: { backendNodeId: number; tag: string; text: string }[];
  attributeChanges: { backendNodeId: number; element: string; attribute: string; oldValue: string | null; newValue: string }[];
  significantChange: boolean;
};

// Heuristics for "significant" changes
const SIGNIFICANT_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select', 'h1', 'h2', 'h3', '[role="button"]', '[role="link"]']);
const MAX_TEXT_LEN = 150;

export async function watchMutations(session: CDP.Client, durationMs: number): Promise<MutationSummary> {
  const { DOM } = session;
  const summary: MutationSummary = {
    newElements: [],
    removedElements: [],
    attributeChanges: [],
    significantChange: false,
  };

  let timeoutId: NodeJS.Timeout | null = null;
  let documentUpdated = false;

  const onDocumentUpdated = () => {
    documentUpdated = true;
    summary.significantChange = true; // Full page load is always significant
  };

  const onAttributeModified = (params: Protocol.DOM.AttributeModifiedEvent) => {
    const { nodeId, name, value } = params;
    // For simplicity, we can't get the old value here without more complex tracking.
    // Let's just record the change.
    summary.attributeChanges.push({
      backendNodeId: nodeId,
      element: `nodeId: ${nodeId}`,
      attribute: name,
      oldValue: "not_tracked", // The protocol doesn't provide the old value directly
      newValue: value,
    });
    summary.significantChange = true; // Assume attribute changes can be significant
  };

  const onChildNodeInserted = async (params: Protocol.DOM.ChildNodeInsertedEvent) => {
    const { parentNodeId, previousNodeId, node } = params;
    // We only care about element nodes
    if (node.nodeType !== 1) return; // 1 = Element Node

    // nodeValue is always null for element nodes (nodeType === 1).
    // For elements, approximate text from nodeValue of first text child.
    // CDP Node type doesn't have textContent, so we fall back to nodeValue.
    const textContent = node.nodeValue || '';
    // CDP DOM attributes are a flattened string array: [name1, value1, name2, value2, ...]
    // Find 'role' by iterating in pairs.
    let role = '';
    const attrs = node.attributes || [];
    for (let ai = 0; ai < attrs.length - 1; ai += 2) {
      if (attrs[ai] === 'role') { role = attrs[ai + 1] || ''; break; }
    }

    summary.newElements.push({
      backendNodeId: node.backendNodeId,
      tag: node.localName,
      text: textContent.substring(0, MAX_TEXT_LEN),
      role,
    });

    if (SIGNIFICANT_TAGS.has(node.localName) || (role && SIGNIFICANT_TAGS.has(`[role="${role}"]`))) {
      summary.significantChange = true;
    }
  };

  const onChildNodeRemoved = (params: Protocol.DOM.ChildNodeRemovedEvent) => {
    const { parentNodeId, nodeId } = params;
    // We don't have info about the removed node other than its ID.
    // A more complex implementation would cache node info.
    summary.removedElements.push({
        backendNodeId: nodeId,
        tag: 'unknown',
        text: 'unknown'
    });
  };

  // --- Main Logic ---
  const promise = new Promise<void>(resolve => {
    timeoutId = setTimeout(resolve, durationMs);
  });

  try {
    // Enable DOM notifications
    await DOM.enable();
    const listeners = [
        DOM.on("documentUpdated", onDocumentUpdated),
        DOM.on("attributeModified", onAttributeModified),
        DOM.on("childNodeInserted", onChildNodeInserted),
        DOM.on("childNodeRemoved", onChildNodeRemoved)
    ];
    await DOM.getDocument({ depth: -1, pierce: true });

    await promise;

  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    // Disabling the DOM agent automatically removes all listeners.
    await DOM.disable();
  }

  return summary;
}
