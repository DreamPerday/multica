/**
 * Warm the three queries that power agent presence (agents + runtimes +
 * agent-task-snapshot) the moment the user enters a workspace. Without this,
 * surfaces that don't otherwise touch these queries (Inbox row, Issue list)
 * flash a dotless avatar on first render while the fetch is in flight.
 *
 * Mirror of packages/core/agents/use-workspace-presence-prefetch.ts — same
 * intent, different sources (mobile-owned queries). usePresenceRealtime() and
 * the 30s tick in useAgentPresence keep these caches fresh after warm-up.
 */
import { useEffect } from "react";
import { InteractionManager } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceStore } from "@/data/workspace-store";
import { agentListOptions } from "@/data/queries/agents";
import { runtimeListOptions } from "@/data/queries/runtimes";
import { agentTaskSnapshotOptions } from "@/data/queries/agent-task-snapshot";

export function useWorkspacePresencePrefetch(): void {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!wsId) return;

    let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
    const interaction = InteractionManager.runAfterInteractions(() => {
      // Presence is supplementary to the first screen. Let inbox/chat/issue
      // data win the cold-start network race, then populate the caches used
      // by avatars and status dots.
      prefetchTimer = setTimeout(() => {
        void Promise.allSettled([
          queryClient.prefetchQuery(agentListOptions(wsId)),
          queryClient.prefetchQuery(runtimeListOptions(wsId)),
          queryClient.prefetchQuery(agentTaskSnapshotOptions(wsId)),
        ]);
      }, 750);
    });

    return () => {
      interaction.cancel();
      if (prefetchTimer) clearTimeout(prefetchTimer);
    };
  }, [queryClient, wsId]);
}
