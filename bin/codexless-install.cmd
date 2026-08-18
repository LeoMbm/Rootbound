@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\install.ps1" -InstallDir "%LOCALAPPDATA%\Codexless\app" %*
exit /b %ERRORLEVEL%
