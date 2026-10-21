!macro MuInstallTrace MESSAGE
  Push $R5
  Push $R6
  ReadEnvStr $R6 "MU_WINDOWS_INSTALL_TRACE"
  ${If} $R6 != ""
    ClearErrors
    FileOpen $R5 "$R6" a
    ${IfNot} ${Errors}
      FileSeek $R5 0 END
      FileWrite $R5 "${MESSAGE}$\r$\n"
      FileClose $R5
    ${EndIf}
  ${EndIf}
  Pop $R6
  Pop $R5
  ClearErrors
!macroend

!macro customInit
  ; The old uninstaller removes its registration. The separate locator lets
  ; a retry without /D find the interrupted target rather than a new default.
  ReadRegStr $R7 HKCU "Software\MuCodeSandbox\WindowsPreviewInstaller\${APP_GUID}" TransactionRoot
  ${If} $R7 != ""
    !insertmacro GetDParameter $R0
    ${If} $R0 == ""
      StrCpy $INSTDIR $R7
    ${EndIf}
  ${EndIf}
  SetOutPath $TEMP
!macroend

!macro MuInstallTransaction ACTION
  System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_TRANSACTION_ACTION", t "${ACTION}")'
  DetailPrint "Windows Preview installation: ${ACTION}"
  nsExec::ExecToStack /TIMEOUT=600000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -EncodedCommand @MU_WINDOWS_TRANSACTION_LOADER@'
  Pop $R9
  Pop $R8
  !insertmacro MuInstallTrace "transaction-${ACTION}=$R9"
  ${If} $R9 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Installation recovery could not be verified. Close the application and retry this installer in the same directory. Existing backups and user data were preserved."
    ${EndIf}
    SetErrorLevel 6
    Quit
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ; Check the selected installation only. Never terminate the management
  ; worker from an installer: its IPC shutdown must confirm VM stop first.
  System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_INSTALL_ROOT", t "$INSTDIR")'
  ; Generated from check-running.ps1, encoded as UTF-16LE. The directory is
  ; environment data so spaces, apostrophes and NSIS characters stay literal.
  nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -EncodedCommand @MU_WINDOWS_RUNNING_CHECK@'
  Pop $R9
  Pop $R8
  !ifdef BUILD_UNINSTALLER
    !insertmacro MuInstallTrace "uninstall-process-check=$R9"
  !else
    !insertmacro MuInstallTrace "install-process-check=$R9"
  !endif
  ${If} $R9 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Please close MuCodeSandbox Windows Preview and wait for its environments to stop, then retry."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    InitPluginsDir
    SetOutPath $PLUGINSDIR
    File "/oname=mu-install-transaction.ps1" "@MU_WINDOWS_TRANSACTION_FILE@"
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_TRANSACTION_SCRIPT", t "$PLUGINSDIR\mu-install-transaction.ps1")'
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_APP_GUID", t "${APP_GUID}")'
    System::Call 'kernel32::GetCurrentProcessId()i.r4'
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_INSTALL_PID", t "$4")'
    !insertmacro MuInstallTransaction "recover"
    ; Check the installed and selected roots before the old uninstaller runs.
    ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_REGISTERED_ROOT", t "$R7")'
    ReadRegStr $R7 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_REGISTERED_VERSION", t "$R7")'
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_INSTALL_VERSION", t "${VERSION}")'
    InitPluginsDir
    SetOutPath $PLUGINSDIR
    File "/oname=mu-check-release.ps1" "@MU_WINDOWS_VERSION_CHECK_FILE@"
    System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_VERSION_SCRIPT", t "$PLUGINSDIR\mu-check-release.ps1")'
    nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -EncodedCommand @MU_WINDOWS_VERSION_CHECK@'
    Pop $R9
    Pop $R8
    !insertmacro MuInstallTrace "install-release-check=$R9"
    ${If} $R9 != 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "This Windows Preview release cannot replace the installed version, or its release metadata could not be verified. Existing files and data were preserved."
      ${EndIf}
      ${If} $R9 == 4
        SetErrorLevel 4
      ${Else}
        SetErrorLevel 5
      ${EndIf}
      Quit
    ${EndIf}
    ; The directory page can select a new parent after .onInit. Create only the
    ; already verified empty target before writing its sibling journal.
    ClearErrors
    CreateDirectory "$INSTDIR"
    ${If} ${Errors}
      SetErrorLevel 6
      Quit
    ${EndIf}
    !insertmacro MuInstallTransaction "prepare"
  !endif
  ; The parent installer also held $INSTDIR as its working directory. Release
  ; that directory before its child uninstaller attempts the sibling rename.
  SetOutPath $TEMP
!macroend

!macro customInstall
  ; Commit only after extraction and registration; interrupted cleanup cannot
  ; roll back a successfully installed release.
  !insertmacro MuInstallTransaction "commit"
!macroend

!macro customRemoveFiles
  Var /GLOBAL MuRemovalStaging
  ; The upstream atomic upgrade moves files into $PLUGINSDIR, which can be
  ; on another volume. Rename this installation into a fresh sibling instead.
  ; Application data and Hyper-V disks have independent locations.
  ${GetParent} "$INSTDIR" $R7
  ${If} $R7 == ""
  ${OrIf} $R7 == $INSTDIR
    Abort "Invalid application removal boundary"
  ${EndIf}
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" +2 0
    Abort "Windows Preview executable missing; installation preserved"
  IfFileExists "$INSTDIR\resources\windows-runtime-manifest.json" +2 0
    Abort "Windows Preview runtime manifest missing; installation preserved"
  ; Do not pre-create and delete a temporary file. On Windows that name may
  ; remain delete-pending and the subsequent directory move returns 80.
  System::Call 'kernel32::GetCurrentProcessId()i.r4'
  System::Call 'kernel32::GetTickCount64()l.r5'
  StrCpy $MuRemovalStaging "$INSTDIR.mu-remove-$4-$5"
  IfFileExists "$MuRemovalStaging" 0 +2
    Abort "Windows Preview removal staging already exists; files preserved"
  SetOutPath $TEMP
  StrCpy $R6 0
  muRemovalRetry:
  System::Call 'kernel32::MoveFileEx(t "$INSTDIR", t "$MuRemovalStaging", i 0)i.r4?e'
  Pop $5
  ${If} $4 == 0
    !insertmacro MuInstallTrace "remove-rename-failed=$5"
    ${If} $R6 < 20
      ${If} $5 == 5
      ${OrIf} $5 == 32
      ${OrIf} $5 == 33
        IntOp $R6 $R6 + 1
        Sleep 250
        Goto muRemovalRetry
      ${EndIf}
    ${EndIf}
    Abort "Unable to move the closed Windows Preview installation; files preserved"
  ${EndIf}
  !insertmacro MuInstallTrace "remove-rename-ok"
  RMDir /r "$MuRemovalStaging"
  ${If} ${Errors}
    !insertmacro MuInstallTrace "remove-cleanup-pending"
  ${Else}
    !insertmacro MuInstallTrace "remove-cleanup-ok"
  ${EndIf}
!macroend
