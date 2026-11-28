/**
 * Find, install and update skills on one machine: where installs go, the
 * search box, the machine's connected repos, and versions with updates.
 * Mounted by the Skills view; nothing here writes to another machine.
 */
import { SkillAdoptPanel } from "./SkillAdoptPanel";
import {
  SkillInstallScopeChoice,
  useSkillInstallScope,
  useSkillProjectFolder,
} from "./SkillInstallScopeChoice";
import { SkillSearch } from "./SkillSearch";
import type { SkillFolderScope } from "./SkillUpdate.logic";
import { SkillUpdatePanel } from "./SkillUpdatePanel";
import { SkillUpdateRepos } from "./SkillUpdateRepos";

export function SkillUpdateCenter(
  props: SkillFolderScope & {
    /** Called after an install or update changed this machine, to read its skills again. */
    onChanged?: () => void;
  },
) {
  const installScope = useSkillInstallScope(props);
  const folder = useSkillProjectFolder(props);
  return (
    <div className="space-y-6 text-sm" data-testid="skill-update-center">
      <div className="space-y-3">
        <SkillInstallScopeChoice {...props} state={installScope} folder={folder} />
        <SkillSearch {...props} installScope={installScope.scope} />
      </div>
      <SkillUpdatePanel {...props} />
      <SkillUpdateRepos {...props} installScope={installScope.scope} />
      {props.userLevel ? (
        <SkillAdoptPanel
          environmentId={props.environmentId}
          projectId={props.projectId}
          onChanged={props.onChanged}
        />
      ) : null}
    </div>
  );
}
