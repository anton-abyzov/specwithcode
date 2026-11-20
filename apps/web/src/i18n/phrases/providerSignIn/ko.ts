import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInKo: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "{environmentLabel}의 다른 GitHub 로그인",
  "These are not Copilot CLI's own sign-in.": "이것들은 Copilot CLI 자체의 로그인이 아닙니다.",
  "Installed on {environmentLabel}. Not signed in yet.":
    "{environmentLabel}에 설치됨. 아직 로그인하지 않았습니다.",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "{environmentLabel}에 설치됨. 로그인이 아직 확인되지 않았습니다.",
  "Not installed on {environmentLabel} yet.": "{environmentLabel}에 아직 설치되지 않았습니다.",
  "Could not read the sign-in state on {environmentLabel}.":
    "{environmentLabel}의 로그인 상태를 읽을 수 없습니다.",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "{environmentLabel}이(가) 이 제공업체를 보고하기를 기다리는 중입니다. 로그인 상태는 아직 알 수 없습니다.",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "건너뛰면 이 제공업체는 로그인 없이 {environmentLabel}에 남습니다. 설정 > 제공업체에서 로그인할 때까지 그곳에서 스레드를 실행할 수 없습니다.",
};
