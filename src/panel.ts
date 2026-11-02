export type PanelView = 'assistant' | 'settings';
export const setupWarningKey = (windowId: number): string => `listenSetupWarning:${windowId}`;
export const panelViewKey = (windowId: number): string => `listenPanelView:${windowId}`;

/** Keep Chrome's side-panel open call in the original button gesture. */
export function openPanel(windowId: number, view: PanelView): Promise<void> {
  const navigation = chrome.storage.session.set({ [panelViewKey(windowId)]: view });
  const opened = chrome.sidePanel.open({ windowId });
  return Promise.all([navigation, opened]).then(() => {});
}
