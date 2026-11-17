import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useDeviceNotificationPermission } from "@/lib/use-device-notification-permission";
import { useT } from "@/lib/i18n";

export function DeviceNotificationPermissionBootstrap() {
  const { permission, loading, request } = useDeviceNotificationPermission();
  const { t } = useT("settings");
  const promptedRef = useRef(false);

  useEffect(() => {
    if (
      Platform.OS === "web" ||
      loading ||
      promptedRef.current ||
      permission.status !== "undetermined" ||
      !permission.canAskAgain
    ) {
      return;
    }

    promptedRef.current = true;
    const timer = setTimeout(() => {
      void request(t("device.channel_name"));
    }, 700);
    return () => clearTimeout(timer);
  }, [loading, permission.canAskAgain, permission.status, request, t]);

  return null;
}
