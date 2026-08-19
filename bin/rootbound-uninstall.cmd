@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\uninstall.ps1" %*
exit /b %ERRORLEVEL%
