import { useCallback, useState } from "react";

/**
 * Keeps native pull-to-refresh feedback tied to an explicit user gesture.
 *
 * TanStack Query's `isRefetching` also becomes true for background
 * invalidations (including realtime REST fallback), which leaves Android's
 * RefreshControl spinner spinning while the user is not refreshing.
 */
export function useManualRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;

    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch, refreshing]);

  return { refreshing, onRefresh };
}
