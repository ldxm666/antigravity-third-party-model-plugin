@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\oneclick.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation stopped. Please read the error above and docs/TROUBLESHOOTING.md.
  pause
  exit /b 1
)
echo.
echo Done. Read docs/QUICKSTART.md for the first provider setup.
pause
