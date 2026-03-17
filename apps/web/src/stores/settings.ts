import { create } from 'zustand';
import { trpcClient } from '../lib/trpc.ts';
import type { UserSettings } from '@orbis/shared';

interface PinnedEntity {
  id: string;
  order: number;
}

interface SettingsState {
  settings: UserSettings | null;
  loading: boolean;
  fetchSettings: () => Promise<void>;
  pinEntity: (id: string) => Promise<void>;
  unpinEntity: (id: string) => Promise<void>;
  installView: (viewId: string) => Promise<void>;
  uninstallView: (viewId: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,

  fetchSettings: async () => {
    set({ loading: true });
    try {
      const settings = await trpcClient.user.getSettings.query();
      set({ settings: settings as unknown as UserSettings, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  pinEntity: async (id: string) => {
    const { settings } = get();
    if (!settings) return;

    const pinned = (settings.pinnedEntities ?? []) as PinnedEntity[];
    if (pinned.some((p) => p.id === id)) return;

    const newPinned = [...pinned, { id, order: pinned.length }];
    await trpcClient.user.updateSettings.mutate({ pinnedEntities: newPinned });
    set({ settings: { ...settings, pinnedEntities: newPinned } });
  },

  unpinEntity: async (id: string) => {
    const { settings } = get();
    if (!settings) return;

    const pinned = (settings.pinnedEntities ?? []) as PinnedEntity[];
    const newPinned = pinned
      .filter((p) => p.id !== id)
      .map((p, i) => ({ ...p, order: i }));

    await trpcClient.user.updateSettings.mutate({ pinnedEntities: newPinned });
    set({ settings: { ...settings, pinnedEntities: newPinned } });
  },

  installView: async (viewId: string) => {
    const { settings } = get();
    if (!settings) return;

    const views = (settings.installedViews as string[]) ?? [];
    if (views.includes(viewId)) return;

    await trpcClient.user.installView.mutate({ viewId });
    // Re-fetch to get updated aspect statuses
    const updated = await trpcClient.user.getSettings.query();
    set({ settings: updated as unknown as UserSettings });
  },

  uninstallView: async (viewId: string) => {
    const { settings } = get();
    if (!settings) return;

    await trpcClient.user.uninstallView.mutate({ viewId });
    const updated = await trpcClient.user.getSettings.query();
    set({ settings: updated as unknown as UserSettings });
  },
}));
