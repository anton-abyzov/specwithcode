import { RequestActionButton } from "./RequestActionButton";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@specweave-studio/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import {
  DEFAULT_APPROVAL_OPTIONS,
  approvalKindTitle,
  approvalOptionTone,
  orderApprovalOptions,
} from "./pendingApprovalPresentation";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  /** Approvals waiting in this thread, this one included; shows "1 of N" above one. */
  readonly pendingCount?: number;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

// About eight lines of text-xs mono; a heredoc or long diff scrolls inside the well
// instead of pushing the feed off screen.
const DETAIL_MAX_HEIGHT = 140;

function DetailWell(props: {
  readonly label: string;
  readonly text: string;
  readonly monospace: boolean;
}) {
  return (
    <View
      className="rounded-xl border border-border bg-subtle"
      style={{ maxHeight: DETAIL_MAX_HEIGHT }}
    >
      <ScrollView
        accessibilityLabel={props.label}
        bounces={false}
        className="min-h-0"
        contentContainerClassName="px-3 py-2.5"
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <Text
          selectable
          className={
            props.monospace
              ? "font-mono text-xs leading-4 text-foreground"
              : "font-sans text-sm leading-normal text-foreground-secondary"
          }
        >
          {props.text}
        </Text>
      </ScrollView>
    </View>
  );
}

function ApprovalOption(props: {
  readonly option: ProviderApprovalOption;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <View className="gap-1.5">
      <RequestActionButton
        label={props.option.label}
        tone={approvalOptionTone(props.option.decision)}
        disabled={props.disabled}
        onPress={props.onPress}
      />
      {props.option.warning ? (
        <Text className="px-1 font-sans text-xs leading-normal text-warning-foreground">
          {props.option.warning}
        </Text>
      ) : null}
    </View>
  );
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const { approval } = props;
  const { stacked, cancel } = orderApprovalOptions(approval.options ?? DEFAULT_APPROVAL_OPTIONS);
  const kindTitle = approvalKindTitle(approval.requestKind);
  const fileChange = approval.requestKind === "file-change" ? approval.fileChange : undefined;
  const pendingCount = props.pendingCount ?? 1;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  const canRespond = approval.responseCapability === "live";
  const disabled =
    !canRespond || props.respondingApprovalId === approval.requestId || !props.canOperateThread;
  const respond = (decision: ProviderApprovalDecision) =>
    void props.onRespond(approval.requestId, decision);
  return (
    <View
      accessibilityLabel={kindTitle}
      className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-studio-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Approval needed
        </Text>
        {pendingCount > 1 ? (
          <Text className="font-studio-medium text-2xs tabular-nums text-foreground-secondary">
            1 of {pendingCount}
          </Text>
        ) : null}
      </View>
      <Text className="font-studio-bold text-lg text-foreground">
        {approval.appName ?? kindTitle}
      </Text>
      {fileChange ? <DetailWell label="File path" text={fileChange.fileName} monospace /> : null}
      {approval.detail ? (
        <DetailWell
          label={approval.requestKind === "command" ? "Command" : "Request detail"}
          text={approval.detail}
          monospace={approval.requestKind !== "mcp-elicitation"}
        />
      ) : null}
      {fileChange?.diffStr ? (
        <DetailWell label="Supplied patch" text={fileChange.diffStr} monospace />
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-adaptive-neutral-600-400">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      <View className="gap-2">
        {stacked.map((option) => (
          <ApprovalOption
            key={option.decision}
            option={option}
            disabled={disabled}
            onPress={() => respond(option.decision)}
          />
        ))}
      </View>
      {cancel ? (
        <View className="items-center gap-1">
          <RequestActionButton
            label={cancel.label}
            tone="quiet"
            disabled={disabled}
            onPress={() => respond(cancel.decision)}
          />
          {cancel.warning ? (
            <Text className="font-sans text-xs leading-normal text-warning-foreground">
              {cancel.warning}
            </Text>
          ) : null}
        </View>
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-adaptive-neutral-500-400">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
}
