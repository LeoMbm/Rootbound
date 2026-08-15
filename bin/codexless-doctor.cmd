@echo off
setlocal
node "%~dp0..\scripts\doctor.mjs" %*
exit /b %ERRORLEVEL%
