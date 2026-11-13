import { useState } from "react";
import { SearchIcon } from "lucide-react";
import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type {
  StudioWorkGrantAccounts,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { useTx } from "../../i18n";
import { ProviderLogo, providerBrandFor, providerBrandForName } from "../ProviderLogo";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SelectButton } from "../ui/select";
import { signInChoices } from "./machineWorkGrants.logic";

type Account = StudioWorkGrantsSnapshot["accounts"][number];

const MODES: ReadonlyArray<{
  readonly kind: StudioWorkGrantAccounts["kind"];
  readonly label: string;
}> = [
  { kind: "all", label: "All" },
  { kind: "listed", label: "Chosen" },
  { kind: "none", label: "None" },
];

/**
 * The picker's rows: signed-in sign-ins first, a chosen one the machine
 * dropped kept so it can be cleared, filtered by `query` on name and account.
 * A chosen row stays under any query.
 */
export function grantSignInRows(
  available: StudioWorkGrantsSnapshot["accounts"],
  chosen: ReadonlyArray<string>,
  query = "",
): ReadonlyArray<Account & { readonly checked: boolean; readonly notSignedIn: boolean }> {
  const needle = query.trim().toLowerCase();
  return signInChoices(available, chosen)
    .filter(
      (account) =>
        !needle ||
        chosen.includes(account.instanceId) ||
        `${account.label} ${account.account ?? ""}`.toLowerCase().includes(needle),
    )
    .map((account) => ({
      ...account,
      checked: chosen.includes(account.instanceId),
      notSignedIn: account.signedIn === false,
    }));
}

function AccountLogo({ account }: { account: Account }) {
  const brand =
    providerBrandFor({ driverKind: account.driver }) ??
    providerBrandForName(account.label, account.driver);
  return brand ? <ProviderLogo brand={brand} className="size-3.5" /> : null;
}

/**
 * Which of this machine's sign-ins a grant's work may use: a popover with
 * All, Chosen or None, and, for Chosen, a searchable list with each
 * provider's logo, signed-in ones first.
 */
export function GrantSignInPicker({
  machineLabel,
  accounts,
  available,
  disabled,
  onChange,
}: {
  machineLabel: string;
  accounts: StudioWorkGrantAccounts;
  available: StudioWorkGrantsSnapshot["accounts"];
  disabled: boolean;
  onChange: (next: StudioWorkGrantAccounts) => void;
}) {
  const tx = useTx();
  const chosen: ReadonlyArray<ProviderInstanceId> =
    accounts.kind === "listed" ? accounts.instanceIds : [];
  const label =
    accounts.kind === "all"
      ? tx("All sign-ins")
      : accounts.kind === "none" || chosen.length === 0
        ? tx("No sign-ins")
        : chosen
            .map((id) => available.find((account) => account.instanceId === id)?.label ?? id)
            .join(", ");
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={tx("Sign-ins {machine} may use", { machine: machineLabel })}
        render={<SelectButton size="xs" className="w-auto max-w-full min-w-0" />}
      >
        {label}
      </PopoverTrigger>
      <PopoverPopup align="start" width="sm" padding="compact">
        <GrantSignInChoices
          accounts={accounts}
          available={available}
          disabled={disabled}
          label={label}
          onChange={onChange}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The mode an arrow key moves to in the All / Chosen / None group, or null for other keys. */
export function signInModeAfterKey(
  current: StudioWorkGrantAccounts["kind"],
  key: string,
): StudioWorkGrantAccounts["kind"] | null {
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return null;
  const index = MODES.findIndex((mode) => mode.kind === current);
  return MODES[(index + step + MODES.length) % MODES.length]!.kind;
}

/**
 * The picker's popup: the All / Chosen / None group (one tab stop, arrow keys
 * move) and, for Chosen, the searchable list. Everything in it is locked while
 * `disabled`, so a click during a save is not silently dropped.
 */
export function GrantSignInChoices({
  accounts,
  available,
  disabled,
  label,
  onChange,
}: {
  accounts: StudioWorkGrantAccounts;
  available: StudioWorkGrantsSnapshot["accounts"];
  disabled: boolean;
  label: string;
  onChange: (next: StudioWorkGrantAccounts) => void;
}) {
  const tx = useTx();
  const [query, setQuery] = useState("");
  const chosen: ReadonlyArray<ProviderInstanceId> =
    accounts.kind === "listed" ? accounts.instanceIds : [];
  const choices = signInChoices(available, chosen);
  const shown = grantSignInRows(available, chosen, query);
  const pick = (kind: StudioWorkGrantAccounts["kind"]) => {
    if (disabled || kind === accounts.kind) return;
    onChange(kind === "listed" ? { kind: "listed", instanceIds: [...chosen] } : { kind });
  };
  return (
    <div className="flex flex-col gap-2" data-slot="grant-sign-in-picker">
      <div
        role="radiogroup"
        aria-label={tx("Sign-ins its work may use")}
        className="grid grid-cols-3 gap-1 rounded-md bg-muted p-0.5 text-xs"
      >
        {MODES.map((mode) => (
          <button
            key={mode.kind}
            type="button"
            role="radio"
            disabled={disabled}
            aria-checked={accounts.kind === mode.kind}
            tabIndex={accounts.kind === mode.kind ? 0 : -1}
            onKeyDown={(event) => {
              const next = signInModeAfterKey(accounts.kind, event.key);
              if (next === null) return;
              event.preventDefault();
              pick(next);
              const buttons = event.currentTarget.parentElement?.querySelectorAll("button");
              buttons?.[MODES.findIndex((item) => item.kind === next)]?.focus();
            }}
            className={`rounded px-2 py-1 ${
              accounts.kind === mode.kind
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => pick(mode.kind)}
          >
            {tx(mode.label)}
          </button>
        ))}
      </div>
      {accounts.kind === "listed" ? (
        choices.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {tx("No sign-ins on this machine yet. Add one under Settings > Providers.")}
          </p>
        ) : (
          <>
            {choices.length > 4 ? (
              <label className="flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs">
                <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tx("Search")}
                  aria-label={tx("Search sign-ins")}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                />
              </label>
            ) : null}
            <ul className="flex max-h-60 flex-col overflow-y-auto" aria-label={label}>
              {shown.map((account) => {
                const checked = account.checked;
                return (
                  <li key={account.instanceId}>
                    <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent/50">
                      <input
                        type="checkbox"
                        className="shrink-0"
                        disabled={disabled}
                        checked={checked}
                        onChange={(event) =>
                          onChange({
                            kind: "listed",
                            instanceIds: event.target.checked
                              ? [...chosen, account.instanceId]
                              : chosen.filter((id) => id !== account.instanceId),
                          })
                        }
                      />
                      <AccountLogo account={account} />
                      <span className="min-w-0 flex-1 truncate">
                        {account.label}
                        {account.account ? (
                          <span className="text-muted-foreground"> · {account.account}</span>
                        ) : null}
                      </span>
                      {account.notSignedIn ? (
                        <span className="shrink-0 text-muted-foreground">
                          {tx("not signed in")}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
              {shown.length === 0 ? (
                <li className="px-1 py-1 text-xs text-muted-foreground">
                  {tx("Nothing matches.")}
                </li>
              ) : null}
            </ul>
          </>
        )
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          {accounts.kind === "all"
            ? tx("Its work may use any sign-in on this machine.")
            : tx("Its work may use no sign-in here, so every launch is refused.")}
        </p>
      )}
    </div>
  );
}
