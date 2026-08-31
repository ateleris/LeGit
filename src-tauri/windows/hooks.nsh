; LeGit NSIS installer hooks (bundle.windows.nsis.installerHooks).

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove what LeGit deployed into WSL distros for the CURRENT user: the
  ; version-keyed agent binaries, the `legit` launcher + host-exe pointer
  ; ($HOME/.local/share/legit) and the ~/.local/bin/legit symlink. Skipped in
  ; update mode ($UpdateMode is set from /UPDATE by the uninstaller): the new
  ; version reuses or redeploys the agent itself.
  ${If} $UpdateMode <> 1
    ; WSL_UTF8=1 makes wsl.exe print UTF-8 instead of UTF-16LE so cmd's
    ; `for /f` can iterate the distro names.
    System::Call 'kernel32::SetEnvironmentVariable(t "WSL_UTF8", t "1")'
    DetailPrint "Removing the LeGit agent from WSL distributions..."
    nsExec::Exec 'cmd /c for /f "usebackq delims=" %d in (`"$SYSDIR\wsl.exe" --list --quiet`) do "$SYSDIR\wsl.exe" -d "%d" --exec /bin/sh -c "rm -rf $$HOME/.local/share/legit; rm -f $$HOME/.local/bin/legit"'
    Pop $0
  ${EndIf}
!macroend
