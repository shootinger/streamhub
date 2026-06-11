; ── Finish page: "Create desktop shortcut" checkbox (checked by default) ──
; Guard installer-only code — electron-builder builds the uninstaller in a first pass
!ifndef BUILD_UNINSTALLER

!macro customHeader
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Créer un raccourci sur le Bureau"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION desktopShortcutAction
!macroend

!macro customInstall
  ; explicit reference keeps NSIS from dead-code removing the function
  GetFunctionAddress $0 desktopShortcutAction
!macroend

Function desktopShortcutAction
  CreateShortcut "$DESKTOP\StreamHub.lnk" "$INSTDIR\StreamHub.exe"
FunctionEnd

!endif ; BUILD_UNINSTALLER

; ── Detect existing installation: propose update instead of full wizard ──
!macro customInit
  SetRegView 64

  ; Read installed version (per-user first, then machine-wide)
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.streamhub.app" "DisplayVersion"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.streamhub.app" "DisplayVersion"
  ${EndIf}

  ${If} $R0 != ""
    ; Already installed — show update confirmation instead of full wizard
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
      "StreamHub v$R0 est déjà installé.$\n$\nCliquez OK pour mettre à jour vers cette version.$\nCliquez Annuler pour quitter." \
      IDOK do_update
    Abort
    do_update:
      SetSilent silent
  ${EndIf}
!macroend
