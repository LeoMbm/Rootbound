@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\install.ps1" -InstallDir "%LOCALAPPDATA%\Rootbound\app" %*
exit /b %ERRORLEVEL%
