// @effect-diagnostics nodeBuiltinImport:off - one small root-owned file, read at each update decision from code with no FileSystem.
import * as NodeFS from "node:fs";

import {
  teamRulesMachinePath,
  teamRulesUpdatePolicyByText,
  type TeamRulesUpdatePolicy,
} from "@specweave-studio/shared/teamRules";

const NO_RULES: TeamRulesUpdatePolicy = { automatic: undefined, feed: undefined, owner: undefined };

/** What the machine's Team rules say about updates. A file that cannot be read counts as broken. */
export function readTeamRulesUpdatePolicy(
  path: string = teamRulesMachinePath(process.platform),
): TeamRulesUpdatePolicy {
  try {
    return teamRulesUpdatePolicyByText(NodeFS.readFileSync(path, "utf8"));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? NO_RULES
      : { automatic: false, feed: undefined, owner: undefined };
  }
}
