import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { notificationPreferenceOptions } from "@/data/queries/notification-preferences";
import { workspaceListOptions } from "@/data/queries/workspaces";
import {
  getDeviceNotificationPermission,
  showMessageNotification,
  type MessageNotificationPayload,
} from "@/lib/device-notifications";
import { useT } from "@/lib/i18n";
import { useWSSubscriptions } from "@/lib/use-ws-subscriptions";

interface DeliverNotificationInput
  extends Omit<MessageNotificationPayload, "slug"> {
  workspaceId: string;
  category: "chat_replies" | "inbox";
}

export function useSystemNotifications() {
  const qc = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const currentWorkspaceId = useWorkspaceStore(
    (state) => state.currentWorkspaceId,
  );
  const currentWorkspaceSlug = useWorkspaceStore(
    (state) => state.currentWorkspaceSlug,
  );
  const { t } = useT("settings");
  const channelName = t("device.channel_name");
  const appStateRef = useRef(AppState.currentState);
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      appStateRef.current = status;
    });
    return () => subscription.remove();
  }, []);

  const deliver = useCallback(
    async ({
      workspaceId,
      category,
      ...payload
    }: DeliverNotificationInput) => {
      if (appStateRef.current === "active") return;
      if (seenRef.current.has(payload.itemId)) return;
      seenRef.current.add(payload.itemId);
      if (seenRef.current.size > 500) {
        const oldest = seenRef.current.values().next().value;
        if (oldest) seenRef.current.delete(oldest);
      }

      const permission = await getDeviceNotificationPermission();
      if (permission.status !== "granted") return;

      let slug =
        workspaceId === currentWorkspaceId ? currentWorkspaceSlug : null;
      if (!slug) {
        const workspaces = await qc.ensureQueryData(workspaceListOptions());
        slug =
          workspaces.find((workspace) => workspace.id === workspaceId)?.slug ??
          null;
      }
      if (!slug) return;

      const preferenceData = await qc.ensureQueryData(
        notificationPreferenceOptions(workspaceId, slug),
      );
      const preferences = preferenceData.preferences;
      if (
        preferences.system_notifications === "muted" ||
        (category === "chat_replies" &&
          preferences.chat_replies === "muted")
      ) {
        return;
      }

      if (useAuthStore.getState().user?.id !== userId) return;
      if (AppState.currentState === "active") return;
      await showMessageNotification({ ...payload, slug }, channelName);
    },
    [channelName, currentWorkspaceId, currentWorkspaceSlug, qc, userId],
  );

  useWSSubscriptions(
    (ws) => [
      ws.on("chat:reply_notification", (payload) => {
        void deliver({
          workspaceId: payload.workspace_id,
          category: "chat_replies",
          itemId: `chat:${payload.message_id}`,
          chatSessionId: payload.chat_session_id,
          title: payload.title,
          body: payload.body,
        });
      }),
      ws.on("inbox:new", ({ item }) => {
        void deliver({
          workspaceId: item.workspace_id,
          category: "inbox",
          itemId: item.id,
          issueKey: item.issue_id ?? item.id,
          title: item.title,
          body: item.body ?? "",
        });
      }),
    ],
    [deliver],
  );
}
