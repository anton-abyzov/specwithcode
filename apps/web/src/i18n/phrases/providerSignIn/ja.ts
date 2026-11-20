import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInJa: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}":
    "{environmentLabel} にあるほかの GitHub サインイン",
  "These are not Copilot CLI's own sign-in.":
    "これらは Copilot CLI 自身のサインインではありません。",
  "Installed on {environmentLabel}. Not signed in yet.":
    "{environmentLabel} にインストール済みです。まだサインインしていません。",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "{environmentLabel} にインストール済みです。サインインはまだ確認されていません。",
  "Not installed on {environmentLabel} yet.":
    "{environmentLabel} にはまだインストールされていません。",
  "Could not read the sign-in state on {environmentLabel}.":
    "{environmentLabel} のサインイン状態を読み取れませんでした。",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "{environmentLabel} がこのプロバイダーを報告するのを待っています。サインイン状態はまだわかりません。",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "スキップすると、このプロバイダーはサインインなしで {environmentLabel} に残ります。設定 > プロバイダー でサインインするまで、そこでスレッドを実行できません。",
};
