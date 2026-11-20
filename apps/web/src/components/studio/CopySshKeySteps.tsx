/**
 * The SSH steps of "Credentials this project uses". A private key never
 * travels and no key crosses the wire here: the new machine makes its own key
 * in a terminal, and this lists the places the project connects to, so the
 * person can tell each one to trust it.
 *
 * The places come from the project's own files, which a cloned repository
 * controls. Each is checked again here before it is put inside a command, is
 * shown as unverified, and nothing on this screen connects anywhere by itself.
 */
import {
  isPrivateSshHost,
  isSafeSshTarget,
  type ProjectCredentialRow,
  type ProjectSshTarget,
} from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { CopyCredentialCommand } from "./CopyCredentialCommand";

export const SSH_PUBLIC_KEY_FILE = "~/.ssh/id_ed25519.pub";

/** Where an account adds an SSH key, for the Git hosts the app knows. */
const GIT_KEY_PAGES: Readonly<Record<string, string>> = {
  "github.com": "https://github.com/settings/ssh/new",
  "gitlab.com": "https://gitlab.com/-/user_settings/ssh_keys",
  "bitbucket.org": "https://bitbucket.org/account/settings/ssh-keys/",
};

/** `user@host`, from parts that passed the contract's patterns. */
export const sshDestination = (target: ProjectSshTarget) =>
  target.user === null ? `${target.host}` : `${target.user}@${target.host}`;

/** A check that cannot ask for a password and cannot read the host as an option. */
export const sshCheckCommand = (target: ProjectSshTarget) =>
  target.kind === "git"
    ? `ssh -o BatchMode=yes -T -- ${sshDestination(target)}`
    : `ssh -o BatchMode=yes -- ${sshDestination(target)} true`;

/** A machine name as a key title: letters, digits, spaces and a few marks, nothing a shell reads. */
export const sshKeyTitle = (label: string) =>
  label
    .replace(/[^A-Za-z0-9 ._-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60);

export const githubAddKeyCommand = (label: string) => {
  const title = sshKeyTitle(label);
  return title === ""
    ? `gh ssh-key add ${SSH_PUBLIC_KEY_FILE}`
    : `gh ssh-key add ${SSH_PUBLIC_KEY_FILE} --title "${title}"`;
};

function Target({
  target,
  sourceLabel,
  targetLabel,
}: {
  readonly target: ProjectSshTarget;
  readonly sourceLabel: string;
  readonly targetLabel: string;
}) {
  const tx = useTx();
  const on = (text: string) =>
    text.replaceAll("{sourceLabel}", sourceLabel).replaceAll("{targetLabel}", targetLabel);
  const from =
    target.variable !== null && target.kind === "server"
      ? tx("{variable} in {file}")
          .replace("{variable}", target.variable)
          .replace("{file}", target.source)
      : target.source === "."
        ? tx("the project's own repository")
        : target.source;
  if (target.kind === "variable")
    return (
      <li className="space-y-1 p-2.5" data-slot="copy-ssh-target" data-kind="variable">
        <p className="text-xs">
          {renderRich(
            tx(
              "{file} takes its host from {variable}. Add the public key on the server you run it against.",
            ),
            {
              file: <span className="font-mono">{target.source}</span>,
              variable: <span className="font-mono">{target.variable}</span>,
            },
          )}
        </p>
      </li>
    );
  const page =
    target.kind === "git" && target.host !== null ? GIT_KEY_PAGES[target.host] : undefined;
  return (
    <li className="space-y-2 p-2.5" data-slot="copy-ssh-target" data-kind={target.kind}>
      <div className="min-w-0">
        <p className="font-mono text-xs font-medium break-all">{sshDestination(target)}</p>
        <p className="text-xs break-words text-muted-foreground">
          {target.kind === "git" ? tx("Git remote") : tx("Server")} · {from}
          {target.host !== null && isPrivateSshHost(target.host) && (
            <span data-slot="copy-ssh-private">
              {" · "}
              {tx("an address inside a private network or this machine")}
            </span>
          )}
        </p>
      </div>
      {target.kind === "git" ? (
        <>
          {page !== undefined ? (
            <p className="text-xs">
              <a
                className="underline underline-offset-2"
                href={page}
                target="_blank"
                rel="noreferrer"
                data-slot="copy-ssh-key-page"
              >
                {tx("Open the page where {host} takes a new SSH key").replace(
                  "{host}",
                  target.host ?? "",
                )}
              </a>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {tx("Add the public key in your account settings on {host}.").replace(
                "{host}",
                target.host ?? "",
              )}
            </p>
          )}
          {target.host === "github.com" && (
            <CopyCredentialCommand
              label={on(tx("Or run this on {targetLabel}, signed in with gh:"))}
              command={githubAddKeyCommand(targetLabel)}
            />
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {renderRich(
            on(
              tx(
                "Sign in to it from {sourceLabel}, which it already trusts, and add the public key as a new line in {file}.",
              ),
            ),
            { file: <span className="font-mono">~/.ssh/authorized_keys</span> },
          )}
        </p>
      )}
      <CopyCredentialCommand
        label={on(
          target.kind === "git"
            ? tx(
                "Then check from {targetLabel}. A greeting with your account name means it worked:",
              )
            : tx("Then check from {targetLabel}:"),
        )}
        command={sshCheckCommand(target)}
      />
    </li>
  );
}

export function CopySshKeySteps({
  row,
  keygen,
  fallbackCheck,
  sourceLabel,
  targetLabel,
}: {
  readonly row: ProjectCredentialRow;
  /** The destination's own command that makes a key. From the app's list. */
  readonly keygen: string;
  /** The app's generic check, for a project whose places are not known. */
  readonly fallbackCheck: string | null;
  readonly sourceLabel: string;
  readonly targetLabel: string;
}) {
  const tx = useTx();
  const on = (text: string) =>
    text.replaceAll("{sourceLabel}", sourceLabel).replaceAll("{targetLabel}", targetLabel);
  // Checked by the machine that read them, by the schema, and here: these go inside commands.
  const sent = row.sshTargets ?? [];
  const targets = sent.filter(isSafeSshTarget);
  const more = row.sshTargetsMore === true || targets.length < sent.length;
  return (
    <div className="space-y-2" data-slot="copy-ssh-steps">
      <p className="text-xs text-muted-foreground">
        {renderRich(
          tx(
            "Private keys stay on {sourceLabel} and are never copied. {targetLabel} gets its own key, and each place below is told to trust it. That way either machine can be switched off alone.",
          ),
          { sourceLabel, targetLabel },
        )}
      </p>
      <CopyCredentialCommand
        label={on(
          tx("1. Run this in a terminal on {targetLabel}. Skip it if {targetLabel} has a key:"),
        )}
        command={keygen}
      />
      <CopyCredentialCommand
        label={tx("2. Print its public key and copy the line. This half is safe to share:")}
        command={`cat ${SSH_PUBLIC_KEY_FILE}`}
      />
      {targets.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {tx("3. Add that line in each place this project connects to:")}
          </p>
          <ul className="divide-y rounded-md border" data-slot="copy-ssh-targets">
            {targets.map((target) => (
              <Target
                key={`${target.kind} ${target.user} ${target.host} ${target.variable} ${target.source}`}
                target={target}
                sourceLabel={sourceLabel}
                targetLabel={targetLabel}
              />
            ))}
          </ul>
          <p className="text-xs text-warning-foreground" data-slot="copy-ssh-unverified">
            {tx(
              "These names were read from the project's files and are not verified. Make sure each one is yours before you add a key there or connect to it.",
            )}
          </p>
          {more && (
            <p className="text-xs text-muted-foreground" data-slot="copy-ssh-more">
              {tx("The project connects to more places than are listed here.")}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {renderRich(
              tx(
                "3. Add that line on each server this project connects to, in {file}, and in your Git host's account settings if you push over SSH.",
              ),
              { file: <span className="font-mono">~/.ssh/authorized_keys</span> },
            )}
          </p>
          {fallbackCheck !== null && (
            <CopyCredentialCommand label={tx("Then see that it worked:")} command={fallbackCheck} />
          )}
        </>
      )}
    </div>
  );
}
