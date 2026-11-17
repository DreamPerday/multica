import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { Text } from "@/components/ui/text";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { agentListOptions } from "@/data/queries/agents";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useNativeSearchBar } from "@/lib/use-native-search-bar";
import { useWorkspacePresenceMap } from "@/lib/use-agent-presence";
import { isAgentRuntimeBound } from "@/lib/is-agent-runtime-bound";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function AgentsPage() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const { t } = useT("workspace");
  const query = useNativeSearchBar(t("agent.search_placeholder"));
  const { data: agents = [], isLoading, error } = useQuery(
    agentListOptions(wsId),
  );
  const { byAgent, loading: presenceLoading } = useWorkspacePresenceMap(wsId);
  const { colorScheme } = useColorScheme();
  const muted = THEME[colorScheme].mutedForeground;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...agents]
      .filter((agent) => !agent.archived_at)
      .filter(
        (agent) =>
          !q ||
          agent.name.toLowerCase().includes(q) ||
          agent.description.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, query]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 bg-background px-4 pt-4">
        <Text className="text-sm text-destructive">
          {t("errors.load_failed", {
            message: error instanceof Error ? error.message : "unknown",
          })}
        </Text>
      </View>
    );
  }

  if (filtered.length === 0) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-sm text-muted-foreground text-center">
          {query.trim() ? t("agent.no_matches") : t("agent.empty")}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <FlashList
        data={filtered}
        keyExtractor={(agent) => agent.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ItemSeparatorComponent={() => (
          <View className="ml-[68px] h-px bg-border" />
        )}
        renderItem={({ item }) => {
          const detail = byAgent.get(item.id);
          const runtimeBound = isAgentRuntimeBound(item);
          const availability =
            !runtimeBound || presenceLoading
              ? null
              : detail?.availability ?? null;
          const statusLabel =
            !runtimeBound
              ? t("agent.needs_runtime")
              : availability === "online"
                ? t("agent.online")
                : availability === "unstable"
                  ? t("agent.reconnecting")
                  : availability === "offline"
                    ? t("agent.offline")
                    : t("agent.checking");
          const selected = item.id === agentId;

          return (
            <Pressable
              disabled={!runtimeBound || !wsSlug}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              onPress={() => {
                if (!wsSlug || !runtimeBound) return;
                router.navigate({
                  pathname: "/[workspace]/chat",
                  params: {
                    workspace: wsSlug,
                    agent: item.id,
                    agentRequest: Date.now().toString(),
                  },
                });
              }}
              className={cn(
                "flex-row items-center gap-3 px-4 py-3.5 active:bg-secondary",
                selected && "bg-secondary/60",
              )}
            >
              <ActorAvatar
                type="agent"
                id={item.id}
                size={40}
                showPresence
              />
              <View className="min-w-0 flex-1">
                <Text
                  className="text-base font-medium text-foreground"
                  numberOfLines={1}
                >
                  {item.name}
                </Text>
                <View className="mt-0.5 flex-row items-center gap-2">
                  {item.description ? (
                    <Text
                      className="min-w-0 flex-1 text-sm text-muted-foreground"
                      numberOfLines={1}
                    >
                      {item.description}
                    </Text>
                  ) : (
                    <View className="flex-1" />
                  )}
                  <Text
                    className={cn(
                      "text-xs",
                      availability === "online"
                        ? "text-success"
                        : availability === "unstable"
                          ? "text-warning"
                          : "text-muted-foreground",
                    )}
                  >
                    {statusLabel}
                  </Text>
                </View>
              </View>
              <PlatformIcon
                sf="chevron.right"
                ion="chevron-forward"
                size={16}
                color={muted}
              />
            </Pressable>
          );
        }}
      />
    </View>
  );
}
