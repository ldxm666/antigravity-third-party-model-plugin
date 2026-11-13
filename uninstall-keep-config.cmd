@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\uninstall.ps1" -KeepConfig
pause
