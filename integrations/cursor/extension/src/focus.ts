/** Which Cursor conversation has focus. Cursor offers no API for it, but two undocumented
 * things line up (found by a spike on Cursor 3.21): `composer.getOrderedSelectedComposerIds`
 * returns the open conversations, and Cursor shows each as an editor tab, in the same order,
 * in one tab group. So the active tab's position in that group names the focused id. When
 * the two disagree (a new chat's tab appears before its id), there is no answer. */

export interface TabView {
  isActive: boolean;
  label: string;
  /** Whether the tab has an input the extension API can describe (a file, a diff…); Cursor's
   * conversation tabs have none. */
  hasInput: boolean;
}

export interface GroupView {
  isActive: boolean;
  tabs: TabView[];
}

export interface Focused {
  session_id: string;
  /** The tab's label: the conversation's title. */
  title: string;
}

export function focusedConversation(
  selected: readonly string[],
  groups: readonly GroupView[],
): Focused | undefined {
  if (selected.length < 2) return undefined;
  const matching = groups.filter(
    (g) => g.tabs.length === selected.length && g.tabs.every((t) => !t.hasInput),
  );
  const group = matching.length === 1 ? matching[0] : matching.find((g) => g.isActive);
  if (!group || (matching.length > 1 && matching.filter((g) => g.isActive).length !== 1)) {
    return undefined;
  }
  const index = group.tabs.findIndex((t) => t.isActive);
  const id = selected[index];
  const tab = group.tabs[index];
  return id && tab ? { session_id: id, title: tab.label } : undefined;
}
