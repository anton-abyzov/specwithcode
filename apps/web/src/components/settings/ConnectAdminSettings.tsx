import type {
  RelayAdminAccount,
  RelayAdminAccountResponse,
  RelayAdminMachine,
  RelayAdminOverviewResponse,
  RelayAdminPhone,
} from "@specweave-studio/contracts/relayAdmin";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  type ConnectAdminFailure,
  readConnectAdmin,
  useConnectAdminOwner,
} from "~/cloud/connectAdminState";
import { useLocale, useTx } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  accountListOf,
  accountSubtitle,
  accountTitle,
  appendAccountPage,
  type ConnectAdminAccountList,
  failureCopy,
  failureIsFinal,
  formatAdminTime,
  LOADING,
  type Loadable,
  machineLimitText,
  machineState,
  overviewTiles,
} from "./ConnectAdminSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ROW = "px-3 py-3 sm:px-4";
const MUTED = "text-xs leading-normal text-muted-foreground";

function Notice({ children }: { readonly children: ReactNode }) {
  return <p className={`${ROW} ${MUTED}`}>{children}</p>;
}

function Pending({ children }: { readonly children: string }) {
  return (
    <p className={`${ROW} ${MUTED} flex items-center gap-2`} role="status">
      <Spinner size="sm" />
      {children}
    </p>
  );
}

/** A failed read, said plainly, with Retry unless asking again cannot help. */
function Failure({
  failure,
  onRetry,
}: {
  readonly failure: ConnectAdminFailure;
  readonly onRetry: () => void;
}) {
  const tx = useTx();
  const copy = failureCopy(failure);
  return (
    <div className={`${ROW} flex flex-wrap items-center justify-between gap-3`} role="alert">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{tx(copy.title)}</p>
        <p className={MUTED}>{tx(copy.description)}</p>
        {failure.status !== null || failure.traceId !== null ? (
          <p className={`${MUTED} font-mono break-all`}>
            {[
              failure.status !== null ? `HTTP ${failure.status}` : null,
              failure.traceId !== null ? `trace ${failure.traceId}` : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </p>
        ) : null}
      </div>
      {failureIsFinal(failure) ? null : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tx("Try again")}
        </Button>
      )}
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={MUTED}>{label}</dt>
      <dd className="text-xs break-words text-foreground">{children}</dd>
    </div>
  );
}

function MachineRow({
  machine,
  locale,
}: {
  readonly machine: RelayAdminMachine;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  const state = machineState(machine);
  const time = (iso: string) => formatAdminTime(iso, locale);
  return (
    <li className="space-y-2 py-2.5" data-testid="connect-admin-machine">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm font-medium break-words text-foreground">
          {machine.label}
        </span>
        <Badge variant={state.tone} size="sm">
          {tx(state.phrase)}
        </Badge>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <Fact label={tx("Tunnel address")}>{machine.hostname ?? tx("No tunnel address")}</Fact>
        <Fact label={tx("Machine id")}>
          <span className="font-mono break-all">{machine.environmentId}</span>
        </Fact>
        <Fact label={tx("Linked")}>{time(machine.linkedAt)}</Fact>
        <Fact label={tx("Last update")}>{time(machine.updatedAt)}</Fact>
        {machine.unlinkedAt !== null ? (
          <Fact label={tx("Unlinked")}>{time(machine.unlinkedAt)}</Fact>
        ) : null}
        {machine.liveChangedAt !== null ? (
          <Fact label={tx("Connection last changed")}>{time(machine.liveChangedAt)}</Fact>
        ) : null}
      </dl>
    </li>
  );
}

function PhoneRow({
  phone,
  locale,
}: {
  readonly phone: RelayAdminPhone;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  const platform = phone.platform === "ios" ? "iOS" : "Android";
  return (
    <li className="space-y-1 py-2.5" data-testid="connect-admin-phone">
      <p className="text-sm font-medium break-words text-foreground">{phone.label}</p>
      <p className={MUTED}>
        {[
          platform,
          phone.model,
          phone.appVersion !== null ? tx("App {version}", { version: phone.appVersion }) : null,
          phone.lastSeenAt !== null
            ? tx("Last seen {time}", { time: formatAdminTime(phone.lastSeenAt, locale) })
            : tx("Never seen"),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
    </li>
  );
}

function AccountDetail({
  detail,
  locale,
  onRetry,
}: {
  readonly detail: Loadable<RelayAdminAccountResponse>;
  readonly locale: string | undefined;
  readonly onRetry: () => void;
}) {
  const tx = useTx();
  if (detail.status === "loading") return <Pending>{tx("Loading machines and phones…")}</Pending>;
  if (detail.status === "failed") return <Failure failure={detail.failure} onRetry={onRetry} />;
  const { machines, phones } = detail.value;
  return (
    <div className={`${ROW} space-y-4 pt-0`}>
      <div>
        <h4 className="text-xs font-semibold text-foreground">{tx("Machines")}</h4>
        {machines.length === 0 ? (
          <p className={`${MUTED} pt-1`}>{tx("No machine has been linked to this account.")}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {machines.map((machine) => (
              <MachineRow key={machine.environmentId} machine={machine} locale={locale} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-foreground">{tx("Phones")}</h4>
        {phones.length === 0 ? (
          <p className={`${MUTED} pt-1`}>{tx("No phone is signed in to this account.")}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {phones.map((phone) => (
              <PhoneRow key={phone.deviceId} phone={phone} locale={locale} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AccountRow({
  account,
  open,
  detail,
  locale,
  onToggle,
  onRetryDetail,
}: {
  readonly account: RelayAdminAccount;
  readonly open: boolean;
  readonly detail: Loadable<RelayAdminAccountResponse>;
  readonly locale: string | undefined;
  readonly onToggle: () => void;
  readonly onRetryDetail: () => void;
}) {
  const tx = useTx();
  const subtitle = accountSubtitle(account);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-testid="connect-admin-account">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`${ROW} flex w-full items-start gap-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <Chevron className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 text-sm font-medium break-words text-foreground">
              {accountTitle(account)}
            </span>
            {account.founderNumber !== null ? (
              <Badge variant="info" size="sm">
                {tx("Founder #{number}", { number: account.founderNumber })}
              </Badge>
            ) : null}
          </span>
          {subtitle ? <span className={`${MUTED} block break-all`}>{subtitle}</span> : null}
          <span className={`${MUTED} block`}>
            {[
              tx("Machines: {count}", { count: account.machineCount }),
              tx("Phones: {count}", { count: account.phoneCount }),
              machineLimitText(tx, account.limit),
            ].join(" · ")}
          </span>
          <span className={`${MUTED} block`}>
            {[
              tx("First seen {time}", { time: formatAdminTime(account.firstSeenAt, locale) }),
              tx("Last seen {time}", { time: formatAdminTime(account.lastSeenAt, locale) }),
            ].join(" · ")}
          </span>
        </span>
      </button>
      {open ? <AccountDetail detail={detail} locale={locale} onRetry={onRetryDetail} /> : null}
    </div>
  );
}

interface ConnectAdminViewProps {
  readonly overview: Loadable<RelayAdminOverviewResponse>;
  readonly list: Loadable<ConnectAdminAccountList>;
  /** The search on screen; null while the newest-first list shows. */
  readonly search: string | null;
  readonly draft: string;
  readonly more: "idle" | "loading" | ConnectAdminFailure;
  readonly selectedUserId: string | null;
  readonly detail: Loadable<RelayAdminAccountResponse>;
  /** A refresh keeps what is on screen until the new answers arrive. */
  readonly refreshing: boolean;
  readonly locale: string | undefined;
  readonly onDraftChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onShowAll: () => void;
  readonly onRefresh: () => void;
  readonly onRetryOverview: () => void;
  readonly onRetryList: () => void;
  readonly onLoadMore: () => void;
  readonly onToggleAccount: (userId: string) => void;
  readonly onRetryDetail: () => void;
}

/** The page without its reads: totals, the account list and one open account. */
function ConnectAdminView(props: ConnectAdminViewProps) {
  const tx = useTx();
  const { overview, list, more } = props;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSearch();
  };

  return (
    <>
      <SettingsSection title="Totals">
        {overview.status === "loading" ? (
          <Pending>{tx("Loading totals…")}</Pending>
        ) : overview.status === "failed" ? (
          <Failure failure={overview.failure} onRetry={props.onRetryOverview} />
        ) : (
          <dl className={`${ROW} grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4`}>
            {overviewTiles(tx, overview.value).map((tile) => (
              <div key={tile.label} className="min-w-0">
                <dt className={MUTED}>{tile.label}</dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">{tile.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsSection>

      <SettingsSection
        title="Accounts"
        headerAction={
          <Button size="xs" variant="outline" disabled={props.refreshing} onClick={props.onRefresh}>
            {props.refreshing ? <Spinner size="sm" /> : null}
            {tx("Refresh")}
          </Button>
        }
      >
        <form className={`${ROW} flex flex-wrap items-center gap-2`} onSubmit={submit}>
          <Input
            className="min-w-0 flex-1 basis-48"
            size="sm"
            type="search"
            autoComplete="off"
            spellCheck={false}
            aria-label={tx("Search accounts")}
            placeholder={tx("Email, name or account id")}
            value={props.draft}
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={props.draft.trim().length === 0}>
            {tx("Search")}
          </Button>
          {props.search !== null ? (
            <Button size="sm" type="button" variant="outline" onClick={props.onShowAll}>
              {tx("Show all")}
            </Button>
          ) : null}
        </form>

        {list.status === "loading" ? (
          <Pending>{tx("Loading accounts…")}</Pending>
        ) : list.status === "failed" ? (
          <Failure failure={list.failure} onRetry={props.onRetryList} />
        ) : (
          <>
            {list.value.identitiesRead ? null : (
              <Notice>
                {tx(
                  "Names and emails could not be read from Clerk. Account ids are shown instead.",
                )}
              </Notice>
            )}
            {list.value.searchTruncated ? (
              <Notice>{tx("More accounts match than are shown. Narrow the search.")}</Notice>
            ) : null}
            {list.value.accounts.length === 0 ? (
              <Notice>
                {props.search !== null
                  ? tx("No account matches that search.")
                  : tx("No one has signed in to SpecWithCode Connect yet.")}
              </Notice>
            ) : (
              list.value.accounts.map((account) => (
                <AccountRow
                  key={account.userId}
                  account={account}
                  open={props.selectedUserId === account.userId}
                  detail={props.detail}
                  locale={props.locale}
                  onToggle={() => props.onToggleAccount(account.userId)}
                  onRetryDetail={props.onRetryDetail}
                />
              ))
            )}
            {more !== "idle" && more !== "loading" ? (
              <Failure failure={more} onRetry={props.onLoadMore} />
            ) : list.value.nextCursor !== null ? (
              <div className={`${ROW} flex justify-center`}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={more === "loading" || props.refreshing}
                  onClick={props.onLoadMore}
                >
                  {more === "loading" ? <Spinner size="sm" /> : null}
                  {tx("Load more")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
    </>
  );
}

function ready<A>(value: A): Loadable<A> {
  return { status: "ready", value };
}

function failed<A>(failure: ConnectAdminFailure): Loadable<A> {
  return { status: "failed", failure };
}

/** The reads behind the page. A late answer to a superseded request is dropped. */
function ConnectAdminPage() {
  const locale = useLocale();
  const [overview, setOverview] = useState<Loadable<RelayAdminOverviewResponse>>(LOADING);
  const [list, setList] = useState<Loadable<ConnectAdminAccountList>>(LOADING);
  const [search, setSearch] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [more, setMore] = useState<"idle" | "loading" | ConnectAdminFailure>("idle");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Loadable<RelayAdminAccountResponse>>(LOADING);
  const overviewRequest = useRef(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const refreshRequest = useRef(0);
  const [refreshing, setRefreshing] = useState(false);

  // The fetches set no state before they answer, so the first one can run from an effect.
  const fetchOverview = useCallback(() => {
    const request = ++overviewRequest.current;
    return readConnectAdmin((client, clerkToken) => client.overview({ clerkToken })).then(
      (result) => {
        if (overviewRequest.current !== request) return;
        setOverview(result.ok ? ready(result.value) : failed(result.failure));
      },
    );
  }, []);

  const fetchList = useCallback((query: string | null) => {
    const request = ++listRequest.current;
    return readConnectAdmin((client, clerkToken) =>
      query === null
        ? client.listAccounts({ clerkToken })
        : client.searchAccounts({ clerkToken, query }),
    ).then((result) => {
      if (listRequest.current !== request) return;
      setList(result.ok ? ready(accountListOf(result.value)) : failed(result.failure));
    });
  }, []);

  const fetchDetail = (userId: string) => {
    const request = ++detailRequest.current;
    return readConnectAdmin((client, clerkToken) => client.account({ clerkToken, userId })).then(
      (result) => {
        if (detailRequest.current !== request) return;
        setDetail(result.ok ? ready(result.value) : failed(result.failure));
      },
    );
  };

  const loadOverview = () => {
    setOverview(LOADING);
    void fetchOverview();
  };

  const loadList = (query: string | null) => {
    setList(LOADING);
    setMore("idle");
    void fetchList(query);
  };

  const loadDetail = (userId: string) => {
    setDetail(LOADING);
    void fetchDetail(userId);
  };

  useEffect(() => {
    const overviewRequests = overviewRequest;
    const listRequests = listRequest;
    const detailRequests = detailRequest;
    void fetchOverview();
    void fetchList(null);
    return () => {
      overviewRequests.current += 1;
      listRequests.current += 1;
      detailRequests.current += 1;
    };
  }, [fetchList, fetchOverview]);

  const loadMore = () => {
    // Not during a refresh: its first page would be joined to a page of the old list.
    if (refreshing) return;
    if (list.status !== "ready" || list.value.nextCursor === null || more === "loading") return;
    const request = listRequest.current;
    const cursor = list.value.nextCursor;
    setMore("loading");
    void readConnectAdmin((client, clerkToken) => client.listAccounts({ clerkToken, cursor })).then(
      (result) => {
        if (listRequest.current !== request) return;
        if (!result.ok) {
          setMore(result.failure);
          return;
        }
        setMore("idle");
        setList((current) =>
          current.status === "ready"
            ? ready(appendAccountPage(current.value, result.value))
            : current,
        );
      },
    );
  };

  const closeAccount = () => {
    detailRequest.current += 1;
    setSelectedUserId(null);
  };

  return (
    <ConnectAdminView
      overview={overview}
      list={list}
      search={search}
      draft={draft}
      more={more}
      selectedUserId={selectedUserId}
      detail={detail}
      refreshing={refreshing}
      locale={locale}
      onDraftChange={setDraft}
      onSearch={() => {
        const query = draft.trim();
        if (query.length === 0) return;
        closeAccount();
        setSearch(query);
        loadList(query);
      }}
      onShowAll={() => {
        closeAccount();
        setDraft("");
        setSearch(null);
        loadList(null);
      }}
      onRefresh={() => {
        // Re-read in place: the list, an open account and the totals stay on
        // screen until their new answers arrive. Pages loaded with "Load more"
        // are read again from the first page.
        const request = ++refreshRequest.current;
        setRefreshing(true);
        setMore("idle");
        void Promise.all([
          fetchOverview(),
          fetchList(search),
          selectedUserId === null ? undefined : fetchDetail(selectedUserId),
        ]).then(() => {
          if (refreshRequest.current === request) setRefreshing(false);
        });
      }}
      onRetryOverview={loadOverview}
      onRetryList={() => loadList(search)}
      onLoadMore={loadMore}
      onToggleAccount={(userId) => {
        if (selectedUserId === userId) {
          closeAccount();
          return;
        }
        setSelectedUserId(userId);
        loadDetail(userId);
      }}
      onRetryDetail={() => {
        if (selectedUserId !== null) loadDetail(selectedUserId);
      }}
    />
  );
}

/**
 * Settings > Connect admin: who uses SpecWithCode Connect, with each account's
 * machines and phones. Read-only. The relay answers only for an owner, so for
 * anyone else this page has nothing to show.
 */
export function ConnectAdminSettings() {
  const tx = useTx();
  const owner = useConnectAdminOwner();
  return (
    <SettingsPageContainer>
      {owner.state === "owner" ? (
        <ConnectAdminPage />
      ) : (
        <SettingsSection title="Connect admin">
          {owner.state === "checking" ? (
            <Pending>{tx("Checking this account…")}</Pending>
          ) : owner.state === "failed" ? (
            <div
              className={`${ROW} flex flex-wrap items-center justify-between gap-3`}
              role="alert"
            >
              <p className="text-sm text-foreground">
                {tx("Could not check whether this account is an owner.")}
              </p>
              <Button size="sm" variant="outline" onClick={owner.retry}>
                {tx("Try again")}
              </Button>
            </div>
          ) : (
            <Notice>{tx("This page is only for the owners of SpecWithCode Connect.")}</Notice>
          )}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
