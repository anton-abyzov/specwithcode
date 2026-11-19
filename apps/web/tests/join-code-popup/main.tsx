// Synthetic data only: no server, account, Connect session or store. A device waits
// for PRCTY-AABYZOV to allow it; the floating code card, the sidebar row and
// Settings > Machines show that code.
import { createRoot } from "react-dom/client";

import { DeviceWaitingForApprovalHost } from "../../src/components/devices/ConnectDeviceHosts";
import { WaitingJoinCodes } from "../../src/components/settings/WaitingJoinCodes";
import { SidebarJoinCodePill } from "../../src/components/sidebar/SidebarJoinCodePill";
import { Shell } from "./shell";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const scene = params.get("scene") ?? "app";

createRoot(document.getElementById("root")!).render(
  <Shell
    footer={<SidebarJoinCodePill />}
    main={scene === "settings" ? <WaitingJoinCodes /> : null}
    host={<DeviceWaitingForApprovalHost />}
  />,
);
