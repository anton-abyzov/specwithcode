import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  BACKGROUND_WORK_SYMBOLS,
  type BackgroundFloatingStatus,
  type BackgroundWorkStop,
  STOP_BACKGROUND_WORK_LABEL,
  STOPPING_BACKGROUND_WORK_LABEL,
} from "./background-work-status";

/** Shows the untruncated work, with a way to copy a long command. */
export function showBackgroundWorkDetails(title: string, details: string): void {
  Alert.alert(title, details, [
    {
      text: "Copy",
      onPress: () => copyTextWithHaptic(details, { target: "background work" }),
    },
    { text: "Done", style: "cancel" },
  ]);
}

// The whole row up to the stop button answers a long press, not only the text line.
const SUMMARY_CLASS_NAME = "h-11 shrink flex-row items-center gap-2";

/**
 * The pill's background-work row: the kind's icon, the work in one short line (a shell
 * command in monospace), and a stop button. A long press anywhere on the icon and label
 * shows the full command; work with no name has nothing more to show and offers none.
 */
export function BackgroundWorkPillContent(props: { readonly status: BackgroundFloatingStatus }) {
  const { status } = props;
  const summary = (
    <>
      <SymbolView
        name={BACKGROUND_WORK_SYMBOLS[status.workKind]}
        size={13}
        tintColorClassName="foreground"
        type="monochrome"
      />
      <Text
        className={
          status.code
            ? "shrink font-mono text-xs text-foreground"
            : "shrink font-studio-medium text-xs text-foreground"
        }
        numberOfLines={1}
      >
        {status.label}
      </Text>
    </>
  );
  const { details } = status;
  return (
    <>
      {details === null ? (
        <View
          accessible
          accessibilityLabel={status.accessibilityLabel}
          className={SUMMARY_CLASS_NAME}
        >
          {summary}
        </View>
      ) : (
        <Pressable
          accessible
          accessibilityLabel={status.accessibilityLabel}
          accessibilityHint="Long press to show all of it"
          accessibilityActions={[{ name: "longpress", label: "Show all of it" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "longpress") {
              showBackgroundWorkDetails(status.detailsTitle, details);
            }
          }}
          onLongPress={() => showBackgroundWorkDetails(status.detailsTitle, details)}
          className={SUMMARY_CLASS_NAME}
        >
          {summary}
        </Pressable>
      )}
      {status.stop !== null ? <BackgroundWorkStopButton stop={status.stop} /> : null}
    </>
  );
}

function BackgroundWorkStopButton(props: { readonly stop: BackgroundWorkStop }) {
  const { stopping, onStop } = props.stop;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={stopping ? STOPPING_BACKGROUND_WORK_LABEL : STOP_BACKGROUND_WORK_LABEL}
      accessibilityState={{ busy: stopping, disabled: stopping }}
      disabled={stopping}
      hitSlop={6}
      onPress={onStop}
      className="-mr-2 h-8 w-8 items-center justify-center rounded-full active:opacity-70"
    >
      {stopping ? (
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
      ) : (
        <SymbolView name="stop.fill" size={11} tintColorClassName="foreground" type="monochrome" />
      )}
    </Pressable>
  );
}
