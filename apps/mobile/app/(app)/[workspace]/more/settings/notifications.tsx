/**
 * Notification preferences subscreen. Inbox groups and system delivery
 * settings are backed by an optimistic PATCH /api/notification-preferences.
 *
 * Copy mirrors packages/views/settings/components/notifications-tab.tsx.
 * Group labels describe the same server-side semantics as web; divergent
 * labels would violate behavioral parity (apps/mobile/CLAUDE.md).
 */
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type {
  NotificationGroupKey,
  NotificationPreferences,
} from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useWorkspaceStore } from "@/data/workspace-store";
import { notificationPreferenceOptions } from "@/data/queries/notification-preferences";
import { useUpdateNotificationPreferences } from "@/data/mutations/notification-preferences";
import { useDeviceNotificationPermission } from "@/lib/use-device-notification-permission";
import { showTestMessageNotification } from "@/lib/device-notifications";
import { useT } from "@/lib/i18n";

const INBOX_GROUPS: {
  key: Exclude<NotificationGroupKey, "system_notifications" | "chat_replies">;
  labelKey: string;
  descriptionKey?: string;
}[] = [
  {
    key: "assignments",
    labelKey: "groups.assignments",
    descriptionKey: "groups.assignments_description",
  },
  {
    key: "status_changes",
    labelKey: "groups.status_changes",
  },
  {
    key: "comments",
    labelKey: "groups.comments",
    descriptionKey: "groups.comments_description",
  },
  {
    key: "mentions",
    labelKey: "groups.mentions",
    descriptionKey: "groups.mentions_description",
  },
  {
    key: "updates",
    labelKey: "groups.updates",
    descriptionKey: "groups.updates_description",
  },
  {
    key: "new_issues",
    labelKey: "groups.new_issues",
    descriptionKey: "groups.new_issues_description",
  },
  {
    key: "agent_activity",
    labelKey: "groups.agent_activity",
    descriptionKey: "groups.agent_activity_description",
  },
];

export default function NotificationsSettingsScreen() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { t } = useT("settings");
  const { data, isLoading, error } = useQuery(
    notificationPreferenceOptions(wsId),
  );
  const mutation = useUpdateNotificationPreferences();
  const {
    permission,
    loading: permissionLoading,
    requesting,
    request,
    openSettings,
  } = useDeviceNotificationPermission();

  const preferences: NotificationPreferences = data?.preferences ?? {};

  const onToggle = (key: NotificationGroupKey, enabled: boolean) => {
    const next: NotificationPreferences = { ...preferences };
    if (enabled) {
      // Default is "all" — omitting the key keeps the object clean.
      delete next[key];
    } else {
      next[key] = "muted";
    }
    mutation.mutate(next);
  };

  const systemEnabled = preferences.system_notifications !== "muted";
  const permissionStatusKey =
    permission.status === "granted"
      ? "device.status_granted"
      : permission.status === "denied"
        ? "device.status_denied"
        : permission.status === "unavailable"
          ? "device.status_unavailable"
          : "device.status_undetermined";
  const canRequestPermission =
    permission.status === "undetermined" || permission.canAskAgain;
  const onPermissionPress = async () => {
    if (permission.status === "granted" || !canRequestPermission) {
      await openSettings();
      return;
    }
    await request(t("device.channel_name"));
  };
  const onSystemToggle = async (enabled: boolean) => {
    if (enabled && permission.status !== "granted") {
      if (canRequestPermission) {
        const next = await request(t("device.channel_name"));
        if (next.status !== "granted") return;
      } else {
        await openSettings();
        return;
      }
    }
    onToggle("system_notifications", enabled);
  };
  const onSendTest = async () => {
    const shown = await showTestMessageNotification(
      t("device.test_title"),
      t("device.test_body"),
      t("device.channel_name"),
    );
    if (!shown) await request(t("device.channel_name"));
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-sm text-destructive text-center">
          {t("errors.load_failed")}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 py-4 gap-6"
    >
      <Section
        title={t("device.title")}
        description={t("device.description")}
      >
        <View className="flex-row items-center px-4 py-3 gap-3">
          <View className="flex-1">
            <Text className="text-base font-medium text-foreground">
              {t("device.permission")}
            </Text>
            <Text className="text-xs text-muted-foreground mt-0.5">
              {permissionLoading
                ? t("device.checking")
                : t(permissionStatusKey)}
            </Text>
          </View>
          <View className="gap-2">
            <Button
              size="sm"
              variant={permission.status === "granted" ? "outline" : "default"}
              className="h-12"
              disabled={permissionLoading || requesting}
              onPress={() => void onPermissionPress()}
            >
              <Text>
                {permission.status === "granted" || !canRequestPermission
                  ? t("device.open_settings")
                  : t("device.allow")}
              </Text>
            </Button>
            {permission.status === "granted" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-12"
                disabled={requesting}
                onPress={() => void onSendTest()}
              >
                <Text>{t("device.test")}</Text>
              </Button>
            ) : null}
          </View>
        </View>
        <Separator />
        <View className="px-4 py-3">
          <Text className="text-xs text-muted-foreground">
            {t("device.background_hint")}
          </Text>
        </View>
      </Section>

      <Section
        title={t("groups.inbox_notifications")}
      >
        {INBOX_GROUPS.map((group, idx) => {
          const enabled = preferences[group.key] !== "muted";
          const isLast = idx === INBOX_GROUPS.length - 1;
          return (
            <View key={group.key}>
              <View className="flex-row items-center px-4 py-3 gap-3">
                <View className="flex-1">
                  <Text className="text-base font-medium text-foreground">
                    {t(group.labelKey)}
                  </Text>
                  {group.descriptionKey ? (
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      {t(group.descriptionKey)}
                    </Text>
                  ) : null}
                </View>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => onToggle(group.key, checked)}
                />
              </View>
              {!isLast ? <Separator /> : null}
            </View>
          );
        })}
      </Section>

      <Section title={t("groups.system")}>
        <View className="flex-row items-center px-4 py-3 gap-3">
          <View className="flex-1">
            <Text className="text-base font-medium text-foreground">
              {t("groups.system_notifications")}
            </Text>
          </View>
          <Switch
            checked={systemEnabled}
            onCheckedChange={(checked) => void onSystemToggle(checked)}
          />
        </View>
        {systemEnabled && (
          <>
            <Separator />
            <View className="flex-row items-center pl-8 pr-4 py-3 gap-3">
              <View className="flex-1">
                <Text className="text-base font-medium text-foreground">
                  {t("groups.chat_replies")}
                </Text>
              </View>
              <Switch
                checked={preferences.chat_replies !== "muted"}
                onCheckedChange={(checked) => onToggle("chat_replies", checked)}
              />
            </View>
          </>
        )}
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="px-1">
        <Text className="text-xs uppercase tracking-wider text-muted-foreground">
          {title}
        </Text>
        {description ? (
          <Text className="text-xs text-muted-foreground mt-1">
            {description}
          </Text>
        ) : null}
      </View>
      <View className="rounded-md border border-border bg-card overflow-hidden">
        {children}
      </View>
    </View>
  );
}
