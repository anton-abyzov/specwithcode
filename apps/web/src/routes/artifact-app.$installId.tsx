import { createFileRoute } from "@tanstack/react-router";

import { ArtifactAppView } from "../components/artifactApps/ArtifactAppView";

function ArtifactAppRoute() {
  const { installId } = Route.useParams();
  return <ArtifactAppView routeInstallId={installId} />;
}

// An installed page's own window; __root.tsx gives this route a bare layout.
export const Route = createFileRoute("/artifact-app/$installId")({
  component: ArtifactAppRoute,
});
