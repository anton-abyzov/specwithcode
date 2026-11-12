import { useState } from "react";
import { AudioLinesIcon, ChevronDownIcon, MicIcon, PhoneIcon, SettingsIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { VoiceConsentDialog, type VoiceCall } from "./VoiceCall";
import type { VoiceDictation } from "./VoiceDictation";
import { VoiceSettings } from "./VoiceSettings";

/** Named actions share one entry point; dialogs survive the menu closing. */
export function ComposerVoiceMenu({
  dictation,
  call,
  disabled = false,
  callDisabled = disabled,
  shortcut,
  renderConsent = true,
}: {
  dictation: VoiceDictation;
  call?: VoiceCall;
  disabled?: boolean;
  callDisabled?: boolean;
  shortcut?: string | null;
  renderConsent?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!dictation.available && !call?.available) return null;
  const active = dictation.active || call?.active;
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant={active ? "secondary" : "ghost"} size="sm" />}
          aria-label="Voice"
          data-composer-voice-menu=""
        >
          <AudioLinesIcon aria-hidden /> Voice <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start">
          {dictation.available ? (
            <MenuItem
              disabled={
                dictation.phase === "finishing" ||
                ((disabled || Boolean(call?.active)) && !dictation.active)
              }
              onClick={() => void (dictation.active ? dictation.stop() : dictation.start())}
            >
              <MicIcon aria-hidden />
              {dictation.active ? "Stop dictating" : "Dictate into the message"}
              {shortcut ? (
                <span className="ms-auto text-xs text-muted-foreground">{shortcut}</span>
              ) : null}
            </MenuItem>
          ) : null}
          {call?.available ? (
            <>
              <MenuItem
                disabled={
                  (callDisabled || dictation.active || call.unavailableReason !== null) &&
                  !call.active
                }
                onClick={() => void (call.active ? call.end() : call.start())}
              >
                <PhoneIcon aria-hidden />
                {call.active ? "End voice call" : "Call the coordinator"}
              </MenuItem>
              {call.unavailableReason && !call.active ? (
                <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">
                  {call.unavailableReason}
                </p>
              ) : null}
              <MenuItem disabled={call.active} onClick={() => setSettingsOpen(true)}>
                <SettingsIcon aria-hidden />
                Voice settings
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {renderConsent ? (
        <VoiceConsentDialog
          open={dictation.consentOpen}
          setupBytes={dictation.setupBytes}
          onCancel={dictation.cancelConsent}
          onAllow={dictation.allow}
          allowLabel="Allow and dictate"
        />
      ) : null}
      {call ? (
        <>
          <VoiceConsentDialog
            open={call.consentOpen}
            setupBytes={call.hostStatus?.setupBytes ?? 0}
            onCancel={call.cancelConsent}
            onAllow={call.allow}
            allowLabel="Allow and call"
          />
          <VoiceSettings
            disabled={call.active}
            controlledOpen={settingsOpen}
            onControlledOpenChange={setSettingsOpen}
          />
        </>
      ) : null}
    </>
  );
}
