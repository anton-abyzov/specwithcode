import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderInstanceId } from "@specweave-studio/contracts";
import { composerChipModel } from "../../src/components/chat/composerModelDisplay";
import { ComposerModelIntent } from "../../src/components/chat/ComposerModelIntent";
const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const picked = { instanceId: ProviderInstanceId.make("acpRegistry_copilot"), model: "claude-opus-5.5" };
function Fixture() {
  const [selection, setSelection] = useState(saved);
  const [explicit, setExplicit] = useState(true);
  return <main><style>{`body{background:#292925;color:#eee;font:16px system-ui;margin:0}main{max-width:720px;margin:40px auto;padding:20px}header{padding:18px;border-bottom:1px solid #555}section{margin-top:180px;border:1px solid #777;border-radius:18px;padding:16px}p{font-size:13px;color:#c5c5bb}button{margin:14px 10px 0 0;padding:10px;border-radius:8px}`}</style>
    <header>Thread: {selection.instanceId} · {selection.model}</header>
    <section><ComposerModelIntent state={composerChipModel({current:selection,pick:picked,pickExplicit:explicit,turnRunning:false}).state} routed={false}/>
      <p>Ask anything</p><strong>GitHub Copilot Enterprise · Claude Opus 5.5</strong></section>
    <button onClick={() => setSelection(picked)}>Simulate server adoption</button>
    <button onClick={() => { setSelection(saved); setExplicit(true); }}>Restore unsent pick</button>
    <button onClick={() => setExplicit(false)}>Seeded draft</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
