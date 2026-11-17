/**
 * MoreTabButton — the real React Navigation More tab button plus its menu.
 *
 * React Navigation renders the same PlatformPressable it uses for every
 * other tab, so icon, label, accessibility state, and spacing stay exact.
 * Pressing it emits tabPress (which the tab layout prevents) and opens a
 * transparent native Modal containing the menu card.
 *
 * The native Modal replaces `@rn-primitives/dropdown-menu` here because its
 * Android Portal did not receive a usable anchor position for this invisible
 * tab action. The menu contents and theme tokens are otherwise unchanged.
 *
 * Visual conventions inside the popover (apps/mobile/CLAUDE.md):
 *   - All glyphs are SF Symbols rendered via expo-image (`sf:` source),
 *     so they share the visual language of the bottom tab bar icons.
 *   - All colours route through THEME tokens (foreground /
 *     mutedForeground / secondary), so dark mode is automatic.
 *   - Workspace is collapsed to a single `<WorkspaceCard>` row (icon +
 *     current workspace name + chevron). Tapping it dismisses the popover
 *     and pushes `/${slug}/switch-workspace`, a formSheet that lists every
 *     workspace and triggers an iOS `Alert.alert` confirm before switching.
 *     Earlier shape (every workspace inlined here) made the popover long
 *     and offered no friction against accidental taps.
 */
import { PlatformIcon, type PlatformIconName } from "@/components/ui/platform-icon";
import { useMemo, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
} from "react-native";
import { router, usePathname } from "expo-router";
import { PlatformPressable } from "expo-router/build/react-navigation/elements";
import type { BottomTabBarButtonProps } from "expo-router/build/react-navigation/bottom-tabs";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { User, Workspace } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar";
import { workspaceListOptions } from "@/data/queries/workspaces";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface NavItem {
  labelKey:
    | "more_menu.pinned"
    | "more_menu.issues"
    | "more_menu.projects"
    | "more_menu.agents"
    | "more_menu.settings";
  /** SF Symbol name for iOS; paired with `ion` for everything else. */
  icon: string;
  /** Ionicons fallback, see components/ui/platform-icon.tsx. */
  ion: PlatformIconName;
  /** Path under /:slug/ — final href is `/${slug}${path}`. */
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { labelKey: "more_menu.pinned", icon: "pin", ion: "pin-outline", path: "/more/pins" },
  { labelKey: "more_menu.issues", icon: "list.bullet", ion: "list", path: "/more/issues" },
  {
    labelKey: "more_menu.projects",
    icon: "square.stack",
    ion: "albums-outline",
    path: "/more/projects",
  },
  {
    labelKey: "more_menu.agents",
    icon: "person.2",
    ion: "people-outline",
    path: "/more/agents",
  },
  {
    labelKey: "more_menu.settings",
    icon: "gearshape",
    ion: "settings-outline",
    path: "/more/settings",
  },
];

export function MoreTabButton(props: BottomTabBarButtonProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();
  const { colorScheme } = useColorScheme();
  const { t } = useT("navigation");
  const { t: tCommon } = useT("common");
  const theme = THEME[colorScheme];
  const currentWorkspace = useCurrentWorkspace(slug);

  const isActive = (path: string) => {
    if (!slug) return false;
    const target = `/${slug}${path}`;
    return pathname === target || pathname.startsWith(target + "/");
  };

  const closeMore = () => setMoreOpen(false);
  const navigate = (path: string) => {
    closeMore();
    if (slug) {
      router.push(`/${slug}${path}`);
    }
  };

  return (
    <>
      <PlatformPressable
        {...props}
        onPress={(event) => {
          props.onPress?.(event);
          setMoreOpen(true);
        }}
      />

      <Modal
        visible={moreOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeMore}
      >
        <View style={{ flex: 1 }}>
          <Pressable
            accessibilityLabel={tCommon("actions.close")}
            onPress={closeMore}
            style={StyleSheet.absoluteFill}
          />

          <View
            className="absolute right-3 w-[336px] rounded-lg border border-border bg-popover p-2 shadow-md shadow-black/10"
            style={{ bottom: insets.bottom + 58 }}
          >
            <UserCard
              user={user}
              onPress={() => navigate("/more/settings")}
              chevronTint={theme.mutedForeground}
              />

            <MenuSeparator />

            <WorkspaceCard
              currentWorkspaceName={currentWorkspace?.name}
              currentWorkspaceAvatarUrl={currentWorkspace?.avatar_url}
              onPress={() => navigate("/switch-workspace")}
              chevronTint={theme.mutedForeground}
            />

            <MenuSeparator />

            {NAV_ITEMS.map((item) => (
              <MenuRow
                key={item.path}
                onPress={() => navigate(item.path)}
                accessibilityLabel={t(item.labelKey)}
                className={cn(
                  "h-9 gap-3",
                  isActive(item.path) && "bg-secondary",
                )}
              >
                <PlatformIcon
                  sf={item.icon}
                  ion={item.ion}
                  size={18}
                  color={theme.foreground}
                />
                <Text className="text-sm text-foreground">
                  {t(item.labelKey)}
                </Text>
              </MenuRow>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

function MenuRow({
  className,
  ...props
}: PressableProps & { className?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        "flex-row items-center gap-2 rounded-sm px-2 py-2 active:bg-accent",
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator() {
  return <View className="-mx-1 my-1 h-px bg-border" />;
}

/**
 * iOS-list-row identity card. Right-side `chevron.right` is the standard
 * disclosure indicator (UITableViewCellAccessoryDisclosureIndicator);
 * this row navigates into settings, so the chevron is idiomatic even
 * though menu items elsewhere in the popover don't use it.
 */
function UserCard({
  user,
  onPress,
  chevronTint,
}: {
  user: User | null;
  onPress: () => void;
  chevronTint: string;
}) {
  const initial = (user?.name ?? user?.email ?? "U").charAt(0).toUpperCase();
  const { t } = useT("navigation");
  return (
    <MenuRow
      onPress={onPress}
      className="h-12 gap-3"
      accessibilityLabel={t("more_menu.account_settings")}
    >
      {user?.avatar_url ? (
        <Image
          source={{ uri: user.avatar_url }}
          className="size-8 rounded-full bg-muted"
        />
      ) : (
        <View className="size-8 rounded-full bg-muted items-center justify-center">
          <Text className="text-xs font-medium text-muted-foreground">
            {initial}
          </Text>
        </View>
      )}
      <View className="flex-1 min-w-0">
        <Text
          className="text-sm font-medium text-foreground"
          numberOfLines={1}
        >
          {user?.name ?? "—"}
        </Text>
        {user?.email ? (
          <Text
            className="text-xs text-muted-foreground"
            numberOfLines={1}
          >
            {user.email}
          </Text>
        ) : null}
      </View>
      <PlatformIcon
        sf="chevron.right"
        ion="chevron-forward"
        size={12}
        color={chevronTint}
      />
    </MenuRow>
  );
}

/**
 * Collapsed single-row entry that shows the current workspace name and
 * pushes the switch-workspace formSheet on tap. Same shape as `UserCard`
 * above — `chevron.right` disclosure indicator signals "tap to descend".
 * Auto-closes the popover because `DropdownMenuItem.onPress` dismisses
 * the menu before our handler runs.
 *
 * When the workspaces query hasn't resolved yet, we still render the row
 * using the slug-derived name from the store so the popover doesn't
 * jump-resize on first open; the row remains tappable because the
 * switch-workspace sheet has its own loading state.
 *
 * Single-workspace users: handled in `MoreTabDropdownAnchor` by passing
 * `disabled` — the row renders with no chevron and no press effect.
 */
function WorkspaceCard({
  currentWorkspaceName,
  currentWorkspaceAvatarUrl,
  onPress,
  chevronTint,
}: {
  currentWorkspaceName: string | undefined;
  currentWorkspaceAvatarUrl: string | null | undefined;
  onPress: () => void;
  chevronTint: string;
}) {
  const { t } = useT("navigation");
  const { data } = useQuery(workspaceListOptions());
  const canSwitch = (data?.length ?? 0) > 1;

  return (
    <MenuRow
      onPress={onPress}
      disabled={!canSwitch}
      className="h-12 gap-3"
      accessibilityLabel={
        canSwitch
          ? t("settings:workspace.switch")
          : currentWorkspaceName ?? t("settings:account.workspace")
      }
    >
      <WorkspaceAvatar
        name={currentWorkspaceName ?? t("settings:account.workspace")}
        avatarUrl={currentWorkspaceAvatarUrl}
        size={32}
      />
      <View className="flex-1 min-w-0">
        <Text
          className="text-sm font-medium text-foreground"
          numberOfLines={1}
        >
          {currentWorkspaceName ?? t("settings:account.workspace")}
        </Text>
      </View>
      {canSwitch ? (
        <PlatformIcon
          sf="chevron.right"
          ion="chevron-forward"
          size={12}
          color={chevronTint}
        />
      ) : null}
    </MenuRow>
  );
}

function useCurrentWorkspace(slug: string | null): Workspace | undefined {
  const { data } = useQuery(workspaceListOptions());
  return useMemo(
    () => (slug ? data?.find((w) => w.slug === slug) : undefined),
    [data, slug],
  );
}
