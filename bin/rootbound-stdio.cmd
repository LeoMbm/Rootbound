@echo off
setlocal
node "%~dp0..\scripts\launch.mjs" stdio
exit /b %ERRORLEVEL%
