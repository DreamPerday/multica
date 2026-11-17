import { useEffect } from "react";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import {
  notificationDestination,
  notificationRouteFromResponse,
} from "@/lib/device-notifications";

export function NotificationResponseBridge() {
  useEffect(() => {
    const openResponse = (
      response: Notifications.NotificationResponse | null,
    ) => {
      const route = notificationRouteFromResponse(response);
      if (!route) return;
      Notifications.clearLastNotificationResponse();
      router.push(notificationDestination(route));
    };

    openResponse(Notifications.getLastNotificationResponse());
    const subscription =
      Notifications.addNotificationResponseReceivedListener(openResponse);
    return () => subscription.remove();
  }, []);

  return null;
}
