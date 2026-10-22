import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { useCallback } from "react";

import { DesignGalleryPage } from "../components/design/gallery/DesignGalleryPage";
import {
  parseDesignGallerySearch,
  type DesignGallerySearch,
} from "../components/design/gallery/galleryModel";

/** `/design` is the gallery; a child route such as `/design/$designKey` renders in its place. */
function DesignRoute() {
  const hasChild = useChildMatches({ select: (matches) => matches.length > 0 });
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The filter is a view of the URL, not history: changing it replaces the entry.
  const onSearchChange = useCallback(
    (next: DesignGallerySearch) => void navigate({ to: "/design", search: next, replace: true }),
    [navigate],
  );
  return hasChild ? (
    <Outlet />
  ) : (
    <DesignGalleryPage search={search} onSearchChange={onSearchChange} />
  );
}

export const Route = createFileRoute("/design")({
  // `?tab=`, `?project=` and `?new=design&owner=&system=`; all optional, so the
  // editor route `/design/$designKey` inherits them harmlessly.
  validateSearch: parseDesignGallerySearch,
  component: DesignRoute,
});
