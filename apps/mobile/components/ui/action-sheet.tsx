/**
 * Cross-platform replacement for React Native's `ActionSheetIOS`.
 *
 * `ActionSheetIOS` is an iOS-only native module. On Android the module simply
 * is not registered, so any call throws at runtime:
 *
 *   Invariant Violation: ActionSheetManager doesn't exist
 *
 * and — because the failing call happens inside a press handler — it takes the
 * whole app down with a JS exception. Every action menu in this app therefore
 * goes through this module instead:
 *
 *   - iOS keeps the native sheet, unchanged (same options object, same
 *     callback with the tapped index, same destructive/cancel styling).
 *   - Android renders the same choices in a bottom sheet built from RN
 *     primitives, so no extra native dependency is involved.
 *
 * Usage mirrors ActionSheetIOS so call sites stay readable:
 *
 *   showActionSheetWithOptions({ options, cancelButtonIndex, destructiveButtonIndex }, (i) => { ... });
 *
 * The Android sheet is mounted once by `ActionSheetProvider` in the root
 * layout; the imperative call above reaches it through a module-level handler.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ColorValue,
} from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export interface ActionSheetOptions {
  /** Button labels, top to bottom. */
  options: string[];
  /** Index rendered as the cancel choice; also reported when the sheet is dismissed. */
  cancelButtonIndex?: number;
  /** Index rendered in the destructive color. */
  destructiveButtonIndex?: number;
  /** Heading above the choices. */
  title?: string;
  message?: string;
  tintColor?: ColorValue;
  /** Accepted for source compatibility with ActionSheetIOS; unused on Android. */
  userInterfaceStyle?: "light" | "dark";
}

type ActionSheetCallback = (buttonIndex: number) => void;

type PendingSheet = {
  options: ActionSheetOptions;
  callback: ActionSheetCallback;
  key: number;
};

type Presenter = (sheet: PendingSheet) => void;

let presentSheet: Presenter | null = null;
let sheetCounter = 0;

/** Drop-in for `ActionSheetIOS.showActionSheetWithOptions`. */
export function showActionSheetWithOptions(
  options: ActionSheetOptions,
  callback: ActionSheetCallback,
): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(options, callback);
    return;
  }

  // Before the provider mounts (or in tests) nothing can render a sheet. Report
  // a cancel instead of throwing: an action menu is not worth crashing over.
  if (!presentSheet) {
    console.warn("[action-sheet] no ActionSheetProvider mounted; treating as cancel");
    callback(options.cancelButtonIndex ?? -1);
    return;
  }

  sheetCounter += 1;
  presentSheet({ options, callback, key: sheetCounter });
}

/** Mounts the Android sheet. Wrap the app's provider tree with this once. */
export function ActionSheetProvider({ children }: { children: React.ReactNode }) {
  const [sheet, setSheet] = useState<PendingSheet | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    presentSheet = (next) => {
      if (mounted.current) setSheet(next);
    };
    return () => {
      mounted.current = false;
      presentSheet = null;
    };
  }, []);

  const close = useCallback(
    (buttonIndex: number) => {
      setSheet((current) => {
        if (current) current.callback(buttonIndex);
        return null;
      });
    },
    [],
  );

  const content = useMemo(() => {
    if (!sheet) return null;

    const { options } = sheet.options;
    const cancelIndex = sheet.options.cancelButtonIndex;
    const destructiveIndex = sheet.options.destructiveButtonIndex;

    const actions = options
      .map((label, index) => ({ label, index }))
      // The cancel choice is rendered as the separated bottom button, like the
      // native sheet does, so it must not be duplicated in the list.
      .filter(({ index }) => index !== cancelIndex);

    return (
      <Modal
        key={sheet.key}
        visible
        transparent
        animationType="fade"
        onRequestClose={() => close(cancelIndex ?? -1)}
      >
        <View className="flex-1 justify-end">
          <Pressable
            className="absolute inset-0 bg-black/40"
            onPress={() => close(cancelIndex ?? -1)}
            accessibilityLabel="Dismiss"
          />
          <View className="m-3 overflow-hidden rounded-2xl bg-card pb-2">
            {sheet.options.title ? (
              <View className="border-b border-border px-4 py-3">
                <Text className="text-center text-xs font-medium text-muted-foreground">
                  {sheet.options.title}
                </Text>
                {sheet.options.message ? (
                  <Text className="mt-1 text-center text-xs text-muted-foreground">
                    {sheet.options.message}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <ScrollView bounces={false} className="max-h-[60vh]">
              {actions.map(({ label, index }) => (
                <Pressable
                  key={`${sheet.key}-${index}`}
                  onPress={() => close(index)}
                  className="border-b border-border px-4 py-4 active:bg-accent"
                  accessibilityRole="button"
                >
                  <Text
                    className={cn(
                      "text-center text-base",
                      index === destructiveIndex
                        ? "text-destructive"
                        : "text-foreground",
                    )}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {cancelIndex !== undefined ? (
              <Pressable
                onPress={() => close(cancelIndex)}
                className="mx-3 mt-2 rounded-xl bg-muted px-4 py-4 active:opacity-70"
                accessibilityRole="button"
              >
                <Text className="text-center text-base font-semibold text-foreground">
                  {options[cancelIndex] ?? "Cancel"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
    );
  }, [sheet, close]);

  return (
    <>
      {children}
      {content}
    </>
  );
}
