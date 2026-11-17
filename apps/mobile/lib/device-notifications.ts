import { Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";

export const MESSAGE_NOTIFICATION_CHANNEL_ID = "multica_messages";

export type DeviceNotificationPermissionStatus =
  | "granted"
  | "undetermined"
  | "denied"
  | "unavailable";

export interface DeviceNotificationPermission {
  status: DeviceNotificationPermissionStatus;
  canAskAgain: boolean;
}

export interface MessageNotificationRoute {
  slug: string;
  itemId: string;
  issueKey?: string;
  chatSessionId?: string;
}

export interface MessageNotificationPayload extends MessageNotificationRoute {
  title: string;
  body: string;
}

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function ensureMessageNotificationChannel(
  name = "Messages",
): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(
    MESSAGE_NOTIFICATION_CHANNEL_ID,
    {
      name,
      description: "Agent replies and inbox alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 220, 120, 220],
      lightColor: "#0b0b0c",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    },
  );
}

export async function getDeviceNotificationPermission(): Promise<DeviceNotificationPermission> {
  if (Platform.OS === "web") {
    return { status: "unavailable", canAskAgain: false };
  }

  const permission = await Notifications.getPermissionsAsync();
  return {
    status:
      permission.status === "granted"
        ? "granted"
        : permission.status === "undetermined"
          ? "undetermined"
          : "denied",
    canAskAgain: permission.canAskAgain,
  };
}

export async function requestDeviceNotificationPermission(
  channelName = "Messages",
): Promise<DeviceNotificationPermission> {
  if (Platform.OS === "web") {
    return { status: "unavailable", canAskAgain: false };
  }

  // Android 13+ requires an existing channel before it will show the runtime
  // notification permission prompt.
  await ensureMessageNotificationChannel(channelName);
  const current = await getDeviceNotificationPermission();
  if (current.status === "granted" || !current.canAskAgain) {
    return current;
  }

  await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: false,
      allowSound: true,
    },
  });
  return getDeviceNotificationPermission();
}

export async function openDeviceNotificationSettings(): Promise<void> {
  if (Platform.OS === "web") return;
  await Linking.openSettings();
}

export async function showMessageNotification(
  payload: MessageNotificationPayload,
  channelName?: string,
): Promise<boolean> {
  if (Platform.OS === "web") return false;

  const permission = await getDeviceNotificationPermission();
  if (permission.status !== "granted") return false;

  await ensureMessageNotificationChannel(channelName);
  const identifier = `multica-${payload.itemId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(-120)}`;

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: payload.title,
      body: payload.body,
      sound: "default",
      autoDismiss: true,
      color: "#0b0b0c",
      data: {
        multica: true,
        slug: payload.slug,
        itemId: payload.itemId,
        issueKey: payload.issueKey,
        chatSessionId: payload.chatSessionId,
      },
    },
    trigger:
      Platform.OS === "android"
        ? { channelId: MESSAGE_NOTIFICATION_CHANNEL_ID }
        : null,
  });
  return true;
}

export async function showTestMessageNotification(
  title: string,
  body: string,
  channelName?: string,
): Promise<boolean> {
  if (Platform.OS === "web") return false;

  const permission = await getDeviceNotificationPermission();
  if (permission.status !== "granted") return false;

  await ensureMessageNotificationChannel(channelName);
  await Notifications.scheduleNotificationAsync({
    identifier: "multica-notification-test",
    content: {
      title,
      body,
      sound: "default",
      autoDismiss: true,
      color: "#0b0b0c",
      data: { multicaTest: true },
    },
    trigger:
      Platform.OS === "android"
        ? { channelId: MESSAGE_NOTIFICATION_CHANNEL_ID }
        : null,
  });
  return true;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function notificationRouteFromResponse(
  response: Notifications.NotificationResponse | null,
): MessageNotificationRoute | null {
  const data = response?.notification.request.content.data;
  if (!data || data.multica !== true) return null;

  const slug = stringValue(data.slug);
  const itemId = stringValue(data.itemId);
  if (!slug || !itemId) return null;

  return {
    slug,
    itemId,
    issueKey: stringValue(data.issueKey),
    chatSessionId: stringValue(data.chatSessionId),
  };
}

export function notificationDestination(
  route: MessageNotificationRoute,
): Href {
  if (route.chatSessionId) {
    return {
      pathname: "/[workspace]/chat",
      params: {
        workspace: route.slug,
        session: route.chatSessionId,
      },
    } as Href;
  }

  return {
    pathname: "/[workspace]/inbox/[id]",
    params: {
      workspace: route.slug,
      id: route.itemId,
    },
  } as Href;
}
