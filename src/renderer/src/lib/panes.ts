/**
 * Pane routing for split-view thread tabs.
 *
 * The main area can show two chats side by side. State:
 * - primaryThreadId: the LEFT pane's thread (== activeThreadId when the left
 *   pane is focused).
 * - paneThreadId: the RIGHT pane's thread; null = single-pane layout.
 * - activeThreadId: the FOCUSED thread.
 *
 * Invariants: whenever a thread is open, activeThreadId is displayed in one of
 * the two panes, and the two panes never show the same thread.
 */
export interface PaneState {
  activeThreadId: string | null;
  primaryThreadId: string | null;
  paneThreadId: string | null;
}

/**
 * Route activating `id` (an open thread) into the panes:
 * - already focused          -> unchanged
 * - shown in the right pane  -> focus it (panes unchanged)
 * - shown in the left pane   -> focus it (panes unchanged)
 * - not shown                -> load it into the FOCUSED pane
 *                              (left pane in single-pane mode)
 */
export function panesForActivate(s: PaneState, id: string): { activeThreadId: string; primaryThreadId: string | null; paneThreadId: string | null } {
  const { activeThreadId, primaryThreadId, paneThreadId } = s;
  if (activeThreadId === id) return { activeThreadId: id, primaryThreadId, paneThreadId };
  if (id === paneThreadId) return { activeThreadId: id, primaryThreadId, paneThreadId };
  if (id === primaryThreadId) return { activeThreadId: id, primaryThreadId, paneThreadId };
  if (paneThreadId !== null && activeThreadId === paneThreadId) {
    // Split active and the right pane is focused: the hidden tab replaces it.
    return { activeThreadId: id, primaryThreadId, paneThreadId: id };
  }
  // Single-pane mode, or split with the left pane focused: replace the left pane.
  return { activeThreadId: id, primaryThreadId: id, paneThreadId };
}

/**
 * Reconcile the panes after `id` was removed from the open tabs.
 * `fallbackActive` is the single-pane successor the caller computed (the last
 * remaining open tab, or null). Closing either pane's thread collapses the
 * split: the surviving pane becomes the single view.
 */
export function panesForClose(s: PaneState, id: string, fallbackActive: string | null): PaneState {
  const { activeThreadId, primaryThreadId, paneThreadId } = s;
  if (id === paneThreadId) {
    return { primaryThreadId, paneThreadId: null, activeThreadId: activeThreadId === id ? primaryThreadId : activeThreadId };
  }
  if (id === primaryThreadId) {
    if (paneThreadId !== null) {
      // Left pane closed while split: the right pane becomes the single view.
      return { primaryThreadId: paneThreadId, paneThreadId: null, activeThreadId: paneThreadId };
    }
    return { primaryThreadId: fallbackActive, paneThreadId: null, activeThreadId: fallbackActive };
  }
  return { primaryThreadId, paneThreadId, activeThreadId };
}
