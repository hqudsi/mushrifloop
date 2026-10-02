; Extra uninstall behaviour (SPEC.md §12 phase 6, NOTES.md §32/§33).
;
; Two things an uninstall must not do quietly: take someone's work with it, or leave a hundred
; megabytes behind. So:
;
;  - the first page of the uninstaller says where the data is and offers, UNTICKED, to delete it;
;  - the caches nobody asked for go every time — the installer's own cached copy in
;    %LOCALAPPDATA%\<name>-updater (111 MB, kept for an auto-update this app does not have) and
;    Chromium's session data in %LOCALAPPDATA%\<name>\session (~34 MB).
;
; A silent uninstall (/S) never shows the page, so the data is kept — the safe default.
; Both paths come from electron-builder's own defines, so they follow APP_NAME.

; Both headers guard against double inclusion, and this file is included before MUI2 is.
!include nsDialogs.nsh
!include LogicLib.nsh

!macro customUnWelcomePage
  UninstPage custom un.dataPageCreate un.dataPageLeave
!macroend

; The script is compiled twice; uninstaller functions only exist in the uninstaller pass,
; or NSIS warns "Uninstaller script code found but WriteUninstaller never used" — and
; electron-builder treats that warning as an error.
!ifdef BUILD_UNINSTALLER
Var unDataCheckbox
Var unDeleteData

Function un.dataPageCreate
  ; MUI2 is included after this file, so the header text is set only when the macro exists.
  !ifmacrodef MUI_HEADER_TEXT
    !insertmacro MUI_HEADER_TEXT "Uninstall ${PRODUCT_NAME}" "Choose what to do with your ${PRODUCT_NAME} data."
  !endif

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "${PRODUCT_NAME} will be removed from this computer.$\r$\n$\r$\nYour tasks, settings and logs are kept unless you ask for them to be deleted:"
  Pop $1

  ${NSD_CreateCheckbox} 0 34u 100% 12u "Also delete my tasks, settings and logs"
  Pop $unDataCheckbox
  ${NSD_SetState} $unDataCheckbox 0 ; unticked: keeping the data is the default

  ${NSD_CreateLabel} 12u 48u 100% 10u "$APPDATA\${PRODUCT_NAME}"
  Pop $2

  ${NSD_CreateLabel} 0 64u 100% 20u "This cannot be undone. Everything a task recorded — its instructions, results and raw output — is in that folder. Work the app committed to your own project folders is not affected."
  Pop $3

  nsDialogs::Show
FunctionEnd

Function un.dataPageLeave
  ${NSD_GetState} $unDataCheckbox $unDeleteData
FunctionEnd
!endif

!macro customUnInstall
  DetailPrint "Removing cached data for ${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}\session"
  ; Only if nothing else of ours is in there.
  RMDir "$LOCALAPPDATA\${PRODUCT_NAME}"

  ${If} $unDeleteData == 1
    DetailPrint "Deleting your ${PRODUCT_NAME} data: $APPDATA\${PRODUCT_NAME}"
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
  ${Else}
    DetailPrint "Keeping your ${PRODUCT_NAME} data in $APPDATA\${PRODUCT_NAME}"
  ${EndIf}
!macroend
