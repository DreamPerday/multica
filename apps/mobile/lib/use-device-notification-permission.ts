import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  getDeviceNotificationPermission,
  openDeviceNotificationSettings,
  requestDeviceNotificationPermission,
  type DeviceNotificationPermission,
} from "@/lib/device-notifications";

const INITIAL_PERMISSION: DeviceNotificationPermission = {
  status: "undetermined",
  canAskAgain: true,
};

export function useDeviceNotificationPermission() {
  const [permission, setPermission] =
    useState<DeviceNotificationPermission>(INITIAL_PERMISSION);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getDeviceNotificationPermission();
    setPermission(next);
    setLoading(false);
    return next;
  }, []);

  const request = useCallback(
    async (channelName?: string) => {
      setRequesting(true);
      try {
        const next =
          await requestDeviceNotificationPermission(channelName);
        setPermission(next);
        return next;
      } finally {
        setRequesting(false);
        setLoading(false);
      }
    },
    [],
  );

  const openSettings = useCallback(async () => {
    await openDeviceNotificationSettings();
  }, []);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  return {
    permission,
    loading,
    requesting,
    refresh,
    request,
    openSettings,
  };
}
