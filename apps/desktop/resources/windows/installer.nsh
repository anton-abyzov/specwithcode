; Keeps Windows shortcuts on the installed executable across renames and updates.
;
; electron-builder names the Windows executable after productName, so builds
; before 1.0 installed "SpecWeave Studio.exe" and nightly builds install
; "SpecWithCode (Nightly).exe", all in the same %LOCALAPPDATA%\Programs\studio
; folder under the same app id. An update that changes the name deletes the old
; executable but leaves the shortcuts that point at it, so Windows reports the
; shortcut target missing and offers to delete it. Every install and update
; (silent ones included) points the product's shortcuts back at $appExe.

!macro specwithcodeRetargetShortcut LINK
  CreateShortCut "${LINK}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
!macroend

; A shortcut under an old name is removed when the current one sits beside
; it, so the desktop does not end up with two; otherwise it is kept under its
; name and pointed at the installed executable. Taskbar pins are never
; removed, only repointed, so the pin stays where the user put it.
!macro specwithcodeRepairShortcut DIR NAME MAY_REMOVE
  ${if} ${FileExists} "${DIR}\${NAME}.lnk"
    ${if} "${MAY_REMOVE}" == "1"
    ${andIf} "${NAME}" != "${SHORTCUT_NAME}"
    ${andIf} ${FileExists} "${DIR}\${SHORTCUT_NAME}.lnk"
      WinShell::UninstShortcut "${DIR}\${NAME}.lnk"
      Delete "${DIR}\${NAME}.lnk"
    ${else}
      !insertmacro specwithcodeRetargetShortcut "${DIR}\${NAME}.lnk"
    ${endIf}
  ${endIf}
!macroend

!macro specwithcodeRepairShortcuts DIR MAY_REMOVE
  !insertmacro specwithcodeRepairShortcut "${DIR}" "SpecWeave Studio" "${MAY_REMOVE}"
  !insertmacro specwithcodeRepairShortcut "${DIR}" "SpecWeave Studio (Nightly)" "${MAY_REMOVE}"
  !insertmacro specwithcodeRepairShortcut "${DIR}" "SpecWithCode" "${MAY_REMOVE}"
  !insertmacro specwithcodeRepairShortcut "${DIR}" "SpecWithCode (Nightly)" "${MAY_REMOVE}"
!macroend

!macro customInstall
  !insertmacro specwithcodeRepairShortcuts "$DESKTOP" "1"
  !insertmacro specwithcodeRepairShortcuts "$SMPROGRAMS" "1"
  !insertmacro specwithcodeRepairShortcuts "$QUICKLAUNCH\User Pinned\TaskBar" "0"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; A full uninstall also removes shortcuts left under an older product name;
; the uninstaller electron-builder generates only knows the current one.
!macro specwithcodeRemoveShortcuts DIR
  Delete "${DIR}\SpecWeave Studio.lnk"
  Delete "${DIR}\SpecWeave Studio (Nightly).lnk"
  Delete "${DIR}\SpecWithCode.lnk"
  Delete "${DIR}\SpecWithCode (Nightly).lnk"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${isKeepShortcuts}
    !insertmacro specwithcodeRemoveShortcuts "$DESKTOP"
    !insertmacro specwithcodeRemoveShortcuts "$SMPROGRAMS"
  ${endIf}
!macroend
