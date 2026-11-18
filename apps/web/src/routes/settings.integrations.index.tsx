import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  integrationsTabForAnchor,
  integrationsTabPath,
} from "../components/settings/integrations/integrationsTabs";

/**
 * `/settings/integrations` has no rows of its own. A link written before the
 * tabs existed names a row by hash; it opens the tab that holds the row.
 */
export const Route = createFileRoute("/settings/integrations/")({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: integrationsTabPath(integrationsTabForAnchor(location.hash)),
      // Every key is kept so the selected machine survives the redirect.
      search: { ...location.search } as never,
      hash: location.hash,
      replace: true,
    });
  },
});
