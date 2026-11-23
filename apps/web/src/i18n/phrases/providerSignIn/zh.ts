import type { PhraseCatalog } from "../../phrases";

/** The provider sign-in step: installed, verified, unknown and skipped (1362). */
export const providerSignInZh: PhraseCatalog = {
  "Other GitHub sign-ins on {environmentLabel}": "{environmentLabel} 上的其他 GitHub 登录",
  "These are not Copilot CLI's own sign-in.": "它们不是 Copilot CLI 自己的登录。",
  "Installed on {environmentLabel}. Not signed in yet.":
    "已安装在 {environmentLabel} 上。尚未登录。",
  "Installed on {environmentLabel}. Sign-in not verified yet.":
    "已安装在 {environmentLabel} 上。登录尚未验证。",
  "Not installed on {environmentLabel} yet.": "尚未安装在 {environmentLabel} 上。",
  "Could not read the sign-in state on {environmentLabel}.":
    "无法读取 {environmentLabel} 上的登录状态。",
  "Waiting for {environmentLabel} to report this provider. Its sign-in state is not known yet.":
    "正在等待 {environmentLabel} 报告此提供方。其登录状态尚不清楚。",
  "Skip keeps this provider on {environmentLabel} without a sign-in. It cannot run threads there until you sign in under Settings > Providers.":
    "跳过会让此提供方留在 {environmentLabel} 上但不登录。在设置 > 提供方 中登录之前，它无法在那里运行会话。",
  "Installed on {environmentLabel}. Google refused this account for Gemini CLI.":
    "已安装在 {environmentLabel}。Google 拒绝此账号使用 Gemini CLI。",
  "Use an API key": "使用 API 密钥",
};
