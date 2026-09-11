; Notify Explorer after replacing the EXE at the same path during an upgrade.
; SHCNE_UPDATEITEM with SHCNF_PATHW | SHCNF_FLUSH refreshes the affected items
; without deleting the user's icon cache or restarting Explorer.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x00001005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
    System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x00001005, w "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  !if "${STARTMENUFOLDER}" != ""
    IfFileExists "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" 0 +2
      System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x00001005, w "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk", p 0)'
  !else
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
      System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x00001005, w "$SMPROGRAMS\${PRODUCTNAME}.lnk", p 0)'
  !endif
!macroend
