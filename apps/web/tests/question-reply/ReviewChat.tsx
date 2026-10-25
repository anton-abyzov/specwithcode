/* Stands in for ChatView's review-only mode inside the requests dialog: the same
   native controls, fed the page's own question through the routing context. */
import { CoordinatorNativeControls } from "../../src/components/studio/CoordinatorNativeControls";
import { useProjectMessageRouting } from "../../src/studio/projectMessageRouting";

const noop = () => {};

export default function ReviewChat(props: { readonly environmentId: string }) {
  const routing = useProjectMessageRouting();
  const question = routing?.coordinatorQuestion?.question ?? null;
  return (
    <CoordinatorNativeControls
      markdownContext={{
        environmentId: props.environmentId as never,
        threadRef: undefined,
        cwd: "/scratch/atlas",
      }}
      loading={false}
      disabled={false}
      error={null}
      approvals={[]}
      respondingApprovals={[]}
      onApproval={async () => undefined}
      questions={question ? [...question.requests] : []}
      answers={question?.answers ?? {}}
      questionIndex={question?.questionIndex ?? 0}
      progress={question?.progress ?? null}
      respondingQuestions={question?.respondingRequestIds ?? []}
      onOption={question?.toggleOption ?? noop}
      onPrevious={question?.previous ?? noop}
      onAdvance={question?.advance ?? noop}
      onDismiss={question?.dismiss ?? noop}
      planMarkdown={null}
      onImplementPlan={async () => true}
    />
  );
}
