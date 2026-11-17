/**
 * Mobile auth store — Zustand. Logic mirrors packages/core/auth/store.ts:
 *   - Token written ONLY on successful verifyCode
 *   - 401 → clear token; non-401 (5xx / network blip) → preserve token so
 *     the next launch can retry
 *   - logout = clear token + clear in-memory user + setToken(null)
 *
 * NOT shared with web/desktop (per Sharing Principles in root CLAUDE.md).
 * Storage backend is expo-secure-store (mobile only); web uses HttpOnly
 * cookies, desktop uses localStorage via StorageAdapter.
 */
import { create } from "zustand";
import type { User } from "@multica/core/types";
import { api, ApiError } from "./api";
import {
  clearCachedUser,
  clearToken,
  getCachedUserJson,
  getToken,
  setCachedUserJson,
  setToken,
} from "./secure-storage";
import { UserSchema } from "./schemas";
import { invalidateSessionEpoch } from "./session-epoch";
import { useWorkspaceStore } from "./workspace-store";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  initialize: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Overwrite the in-memory user — call after PATCH /api/me so name/avatar
   *  edits land without a refetch. Server response is the source of truth. */
  setUser: (user: User) => void;
}

function parseCachedUser(raw: string | null): User | null {
  if (!raw) return null;
  try {
    const parsed = UserSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id ? parsed.data : null;
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,

  initialize: async () => {
    // Restore the persisted workspace slug alongside the auth token so the
    // entry redirect (app/index.tsx) can route directly to the last-used
    // workspace without flashing /select-workspace.
    await useWorkspaceStore.getState().restoreSlug();

    const [token, cachedUserJson] = await Promise.all([
      getToken(),
      getCachedUserJson(),
    ]);
    if (!token) {
      await clearCachedUser();
      set({ isLoading: false });
      return;
    }
    api.setToken(token);
    const cachedUser = parseCachedUser(cachedUserJson);
    if (cachedUser) {
      // Render the authenticated shell immediately. getMe below remains the
      // source of truth and corrects/evicts this optimistic profile.
      set({ user: cachedUser, isLoading: false });
    }
    try {
      const user = await api.getMe();
      set({ user, isLoading: false });
      void setCachedUserJson(JSON.stringify(user)).catch(() => undefined);
    } catch (err) {
      // Only clear token on a genuine 401. Network blips / 5xx keep the
      // token so the next launch (or a manual refresh) can retry.
      const unauthorized = err instanceof ApiError && err.status === 401;
      if (unauthorized) {
        // Synchronous first, before the awaited delete: anything already
        // in flight has to learn the credential is dead now, not once the
        // Keychain write lands.
        invalidateSessionEpoch();
        await clearToken();
        api.setToken(null);
      }
      set({ user: unauthorized ? null : cachedUser, isLoading: false });
    }
  },

  sendCode: async (email) => {
    await api.sendCode(email);
  },

  verifyCode: async (email, code) => {
    const { token, user } = await api.verifyCode(email, code);
    // Signing in replaces the credential just as decisively as signing out:
    // a renewal still in flight for the previous account must not write its
    // result over this one.
    invalidateSessionEpoch();
    await setToken(token);
    api.setToken(token);
    set({ user });
    void setCachedUserJson(JSON.stringify(user)).catch(() => undefined);
    return user;
  },

  logout: async () => {
    // First statement in the function, before any await. The Keychain delete
    // below is async, so until it lands a concurrent read still returns the
    // token being removed — the epoch is what makes this instant.
    invalidateSessionEpoch();
    await clearToken();
    api.setToken(null);
    set({ user: null });
  },

  setUser: (user) => {
    set({ user });
    void setCachedUserJson(JSON.stringify(user)).catch(() => undefined);
  },
}));
