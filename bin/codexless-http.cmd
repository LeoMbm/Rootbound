@echo off
setlocal
node "%~dp0..\scripts\launch.mjs" http
exit /b %ERRORLEVEL%
