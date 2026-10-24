import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    /** Set while the app refuses new work: an install is under way or the app is quitting. */
    readonly quitting: Ref.Ref<boolean>;
    /**
     * Set once the app really started to quit (before-quit,
     * before-quit-for-update, a signal or a relaunch). Unlike `quitting`, an
     * install that has not quit the app yet leaves it unset.
     */
    readonly shutdownBegun: Ref.Ref<boolean>;
    /**
     * Set by before-quit-for-update: Electron's updater owns that quit, so
     * before-quit lets it through. An install that did not quit clears it.
     */
    readonly updaterQuitAllowed: Ref.Ref<boolean>;
  }
>()("@specweave-studio/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  shutdownBegun: Ref.make(false),
  updaterQuitAllowed: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
