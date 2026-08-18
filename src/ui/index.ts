// src/ui/index.ts — DEPRECATED: All UI moved to ext-dist/content.js (Chrome extension)
// Legacy GhostOverlay (tactical overlay, ask modal) has been removed.
// The extension content script now handles:
//   - WeaveCursor (canvas-based, shadow-DOM isolated)
//   - Thought bubble (.wt-bubble with typewriter + hex icon)
//   - Ask modal (.wt-chat input + Reply button)
//   - HUD (token recorder, bottom-right)
//   - X-Ray spotlight, controlled tab indicator, ripple effects
//
// This file is kept as a build stub so esbuild doesn't error.
// It exports nothing and does nothing.
