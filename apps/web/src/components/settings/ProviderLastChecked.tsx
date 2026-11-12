import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { getRelativeTimeState } from "../../timestampFormat";
import { useRelativeTimeTick } from "./settingsLayout";

/** "Checked 2 minutes ago", kept current while it is on screen. */
export function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  const tx = useTx();
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span>{tx("Checked unavailable")}</span>;
  }

  return (
    <span>
      {lastCheckedRelative.suffix ? (
        <>
          {tx("Checked")}{" "}
          <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>{renderRich(tx("Checked {value}"), { value: lastCheckedRelative.value })}</>
      )}
    </span>
  );
}
