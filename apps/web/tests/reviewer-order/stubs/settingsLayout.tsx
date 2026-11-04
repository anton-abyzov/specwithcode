// Row chrome as SettingsRow draws it, without the live scope stores behind
// its inheritance indicator.
import type { ReactNode } from "react";

export {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  useRelativeTimeTick,
} from "../../../src/components/settings/settingsLayout";

export function SettingsRow(props: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly status?: ReactNode;
  readonly resetAction?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div
      id={props.id}
      data-slot="settings-row"
      className={`@container/settings-row min-w-0 [overflow-wrap:anywhere] rounded-xl px-3 sm:px-4 ${props.children ? "pt-3 pb-1" : "py-3"}`}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,40%)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="min-w-0 text-sm font-medium text-foreground">{props.title}</h3>
            {props.resetAction ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {props.resetAction}
              </span>
            ) : null}
          </div>
          {props.description ? (
            <div className="max-w-xl text-xs leading-normal text-muted-foreground">
              {props.description}
            </div>
          ) : null}
          {props.status ? (
            <div className="pt-0.5 text-xs text-muted-foreground">{props.status}</div>
          ) : null}
        </div>
        {props.control ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 [&>*]:max-w-full @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {props.control}
          </div>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}
