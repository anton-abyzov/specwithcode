import { useNavigation } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { CoordinatorReplySource } from "@specweave-studio/shared/coordinatorReplySources";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useThreadShell } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { replySourceThreadTarget } from "./replySourceModel";

function ThreadSourceLink({
  source,
}: {
  source: Extract<CoordinatorReplySource, { kind: "thread" }>;
}) {
  const navigation = useNavigation();
  const environments = useWorkspaceEnvironments();
  const ref = {
    environmentId: EnvironmentId.make(source.environmentId),
    threadId: ThreadId.make(source.threadId),
  };
  const thread = useThreadShell(ref);
  const target = replySourceThreadTarget(source, environments);
  const title = thread?.title.trim() || source.title?.trim() || "View source thread";
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open source thread ${title}${target ? "" : ", unavailable"}`}
      accessibilityState={{ disabled: target === null }}
      disabled={target === null}
      onPress={() => navigation.navigate("Thread", ref)}
      className="min-h-11 max-w-full justify-center rounded-lg bg-subtle px-2 py-1"
    >
      <Text className="text-xs text-foreground-secondary">
        re: {title}
        {target ? " →" : " · unavailable"}
      </Text>
    </Pressable>
  );
}

export function ReplySourceLinks({ sources }: { sources: readonly CoordinatorReplySource[] }) {
  if (sources.length === 0) return null;
  return (
    <View className="mb-1 flex-row flex-wrap gap-1">
      {sources.map((source, index) =>
        source.kind === "thread" ? (
          <ThreadSourceLink key={`${source.environmentId}:${source.threadId}`} source={source} />
        ) : source.kind === "pull_request" ? (
          <Pressable
            key={source.url}
            accessibilityRole="link"
            accessibilityLabel={`Open ${source.title}`}
            onPress={() => {
              void tryOpenExternalUrl(source.url, "pull-request");
            }}
            className="min-h-11 max-w-full justify-center rounded-lg bg-subtle px-2 py-1"
          >
            <Text className="text-xs text-foreground-secondary">re: {source.title} →</Text>
          </Pressable>
        ) : (
          <Text key={`event:${index}`} className="py-2 text-xs text-foreground-secondary">
            re: {source.title}
          </Text>
        ),
      )}
    </View>
  );
}
