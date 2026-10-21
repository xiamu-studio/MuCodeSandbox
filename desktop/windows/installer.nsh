!macro customCheckAppRunning
  ; Check the selected installation only. Never terminate the management
  ; worker from an installer: its IPC shutdown must confirm VM stop first.
  System::Call 'kernel32::SetEnvironmentVariable(t "MU_WINDOWS_INSTALL_ROOT", t "$INSTDIR")'
  ; Generated from check-running.ps1, encoded as UTF-16LE. The directory is
  ; environment data so spaces, apostrophes and NSIS characters stay literal.
  nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -EncodedCommand @MU_WINDOWS_RUNNING_CHECK@'
  Pop $R9
  Pop $R8
  ${If} $R9 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Please close MuCodeSandbox Windows Preview and wait for its environments to stop, then retry."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; The parent installer also held $INSTDIR as its working directory. Release
  ; that directory before its child uninstaller attempts the sibling rename.
  SetOutPath $TEMP
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
  GetTempFileName $MuRemovalStaging "$R7"
  Delete "$MuRemovalStaging"
  SetOutPath $TEMP
  ClearErrors
  Rename "$INSTDIR" "$MuRemovalStaging"
  ${If} ${Errors}
    Abort "Unable to move the closed Windows Preview installation; files preserved"
  ${EndIf}
  RMDir /r "$MuRemovalStaging"
!macroend
