/**
 * UI state — sidebar collapse, active page title, global notification drawer.
 * Not persisted — resets to defaults on every page load.
 */

import { create } from "zustand";

interface UiState {
  sidebarOpen:  boolean;
  pageTitle:    string;

  toggleSidebar:    () => void;
  setSidebarOpen:   (open: boolean) => void;
  setPageTitle:     (title: string) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarOpen: true,
  pageTitle:   "Dashboard",

  toggleSidebar:  () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setPageTitle:   (title) => set({ pageTitle: title }),
}));
