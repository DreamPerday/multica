import { useMemo, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Text } from "@/components/ui/text";
import { chatSessionsOptions } from "@/data/queries/chat";
import { useUpdateChatSessionTitle } from "@/data/mutations/chat";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

export default function ChatSessionRenameRoute() {
  const { sessionId, initialTitle = "" } = useLocalSearchParams<{
    sessionId: string;
    initialTitle?: string;
  }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { data: sessions = [] } = useQuery(chatSessionsOptions(wsId));
  const session = useMemo(
    () => sessions.find((item) => item.id === sessionId),
    [sessionId, sessions],
  );
  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  const title = editedTitle ?? session?.title ?? initialTitle;
  const update = useUpdateChatSessionTitle();
  const { t } = useT("chat");

  const trimmed = title.trim();
  const canSave =
    !!session &&
    trimmed.length > 0 &&
    trimmed !== (session.title ?? "").trim() &&
    !update.isPending;

  const onSave = async () => {
    if (!session || !canSave) return;
    try {
      await update.mutateAsync({ sessionId: session.id, title: trimmed });
      router.back();
    } catch (err) {
      Alert.alert(
        t("session_actions.rename_failed"),
        err instanceof Error ? err.message : t("common:states.error"),
      );
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("session_actions.rename_title"),
          headerRight: () => (
            <Pressable
              onPress={() => void onSave()}
              disabled={!canSave}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
            >
              <Text
                className={
                  canSave
                    ? "text-base font-semibold text-brand"
                    : "text-base font-semibold text-muted-foreground/40"
                }
              >
                {update.isPending
                  ? t("session_actions.saving")
                  : t("session_actions.save")}
              </Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView
        behavior="padding"
        automaticOffset
        className="flex-1 bg-background"
      >
        <View className="px-4 pt-4">
          <TextInput
            value={title}
            onChangeText={setEditedTitle}
            autoFocus
            maxLength={200}
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => void onSave()}
            placeholder={t("session_actions.rename_placeholder")}
            className="rounded-lg border border-border bg-secondary/40 px-3.5 py-3 text-base text-foreground"
          />
          {!session ? (
            <Text className="mt-3 text-sm text-muted-foreground">
              {t("session_actions.session_missing")}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </>
  );
}
