import { InfoIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { describeMissingCheckout, type MissingCheckoutChoice } from "./ProjectSettingsPanel.logic";

/** A project with no checkout on the picked environment explains why and offers where to go. */
export function ProjectCheckoutMissing({
  group,
  environments,
  environmentId,
  checkoutKey,
  onPick,
}: {
  group: {
    readonly projectKey: string;
    readonly displayName: string;
    readonly memberProjects: Parameters<typeof describeMissingCheckout>[0]["members"];
  };
  environments: Parameters<typeof describeMissingCheckout>[0]["environments"];
  environmentId: string | null;
  checkoutKey: string | null;
  onPick: (search: MissingCheckoutChoice["search"]) => void;
}) {
  const { title, detail, choices } = describeMissingCheckout({
    projectKey: group.projectKey,
    projectName: group.displayName,
    members: group.memberProjects,
    environmentId,
    checkoutKey,
    environments,
  });
  return (
    <Alert role="status" controlAlignment="first-line" data-testid="project-checkout-missing">
      <InfoIcon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{detail}</p>
        {choices.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={choice.key}
                size="sm"
                variant="outline"
                onClick={() => onPick(choice.search)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
