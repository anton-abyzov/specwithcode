import type {
  DesignAddress,
  DesignAudience,
  DesignDocument,
  DesignSystem,
  DesignThreadBinding,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";
import { decodeDesignKey } from "~/components/design/designKey";
import { DesignEditor } from "~/components/design/editor/DesignEditor";
import { MissingDesignDetail } from "~/components/design/gallery/MissingDesignDetail";
import { useConnectDesign } from "~/components/design/gallery/useConnectDesign";
import { useMovedDesignRedirect } from "~/components/design/movedDesign";
import { useDesignAssetUrls } from "~/components/design/editor/designAssets";
import {
  useAppDesignBackend,
  useAppDesignDocument,
} from "~/components/design/editor/useAppDesignBackend";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

const ChatView = lazy(() => import("~/components/ChatView"));

export const Route = createFileRoute("/design/$designKey")({ component: DesignRoute });

function DesignRoute() {
  const { designKey } = Route.useParams();
  const decoded = useMemo(() => decodeDesignKey(designKey), [designKey]);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const projectId = decoded?.owner.kind === "project" ? decoded.owner.projectId : null;
  const project =
    projectId === null
      ? null
      : (projects.find(
          (candidate) =>
            candidate.id === projectId && candidate.environmentId === primaryEnvironmentId,
        ) ??
        projects.find((candidate) => candidate.id === projectId) ??
        null);
  const environmentId =
    decoded === null
      ? null
      : decoded.owner.kind === "project"
        ? (project?.environmentId ?? null)
        : primaryEnvironmentId;
  const address = useMemo<DesignAddress | null>(
    () => (decoded === null ? null : { owner: decoded.owner, designId: decoded.designId }),
    [decoded],
  );
  const loaded = useAppDesignDocument(environmentId, address);
  // A design that moved into a project answers its old link with where it went.
  useMovedDesignRedirect(loaded.movedTo);
  const ownerLabel =
    decoded?.owner.kind === "playground" ? "Playground" : (project?.title ?? "Project");

  let body;
  if (decoded === null)
    body = (
      <Message title="This design link is not valid">
        Open the design again from the Design gallery.
      </Message>
    );
  else if (environmentId === null)
    body =
      decoded.owner.kind === "project" ? (
        <Message title="Project not on this machine">
          The design's project is not open in the app here. Add the project, then open the design
          again.
        </Message>
      ) : (
        <Message title="Connecting">Waiting for this Mac to connect.</Message>
      );
  else if (loaded.movedTo !== null)
    body = (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <Spinner />
      </div>
    );
  else if (loaded.notFound)
    body = (
      <Message title="Design not found">
        <MissingDesignDetail detail={loaded.notFoundDetail ?? null} project={project} />
      </Message>
    );
  else if (loaded.error !== null && loaded.initial === null)
    body = <Message title="Could not open the design">{loaded.error}</Message>;
  else if (loaded.initial === null || address === null)
    body = (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <Spinner />
      </div>
    );
  else
    body = (
      <LoadedDesign
        key={designKey}
        designKey={designKey}
        environmentId={environmentId}
        address={address}
        ownerLabel={ownerLabel}
        initial={loaded.initial}
        live={loaded.live}
        system={loaded.system}
        audience={loaded.audience}
      />
    );

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {body}
    </SidebarInset>
  );
}

function LoadedDesign(props: {
  designKey: string;
  environmentId: EnvironmentId;
  address: DesignAddress;
  ownerLabel: string;
  initial: DesignDocument;
  live: DesignDocument | null;
  system: DesignSystem | null;
  audience: DesignAudience | null;
}) {
  const backend = useAppDesignBackend({
    environmentId: props.environmentId,
    address: props.address,
    designKey: props.designKey,
    ownerLabel: props.ownerLabel,
    title: (props.live ?? props.initial).title,
    audience: props.audience,
  });
  // "Connect to a project" for a Playground design: once it moved, its new address replaces this one.
  const navigate = useNavigate();
  const connect = useConnectDesign({
    environmentId: props.environmentId,
    owner: backend.audience === "owner",
    onMoved: ({ route }) => void navigate({ ...route, replace: true }),
  });
  const editorBackend =
    connect.available && props.address.owner.kind === "playground"
      ? {
          ...backend,
          connectToProject: (current: () => DesignDocument) =>
            connect.request({
              designId: props.address.designId,
              title: current().title,
              hasDesignSystem: current().designSystem !== null,
              thread: current().thread ?? null,
              revision: () => current().revision,
            }),
        }
      : backend;
  const assetUrl = useDesignAssetUrls(
    props.environmentId,
    props.address,
    props.live ?? props.initial,
  );
  const data = useMemo(
    () => ({ initial: props.initial, live: props.live, system: props.system, assetUrl }),
    [assetUrl, props.initial, props.live, props.system],
  );
  const renderChat = useCallback(
    (binding: DesignThreadBinding) => (
      <RenderErrorBoundary fallback={null} resetKeys={[binding.environmentId, binding.threadId]}>
        <Suspense fallback={null}>
          <ChatView
            key={`${binding.environmentId}:${binding.threadId}`}
            environmentId={binding.environmentId}
            threadId={binding.threadId}
            routeKind="server"
            layoutMode="embedded"
            embeddedHeaderToolsTarget={null}
            reserveTitleBarControlInset={false}
          />
        </Suspense>
      </RenderErrorBoundary>
    ),
    [],
  );
  return (
    <>
      <DesignEditor
        backend={editorBackend}
        data={data}
        designKey={props.designKey}
        renderChat={renderChat}
      />
      {connect.dialog}
    </>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Design</h1>
      </WorkspacePageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
