@echo off
rem specwithcode-desktop-shim 1
rem The specwithcode command inside the SpecWithCode app. It runs this app's own
rem command-line tool, so the command and the app are always the same version.
setlocal
for %%I in ("%~dp0..") do set "SWC_RESOURCES=%%~fI"
for %%I in ("%SWC_RESOURCES%\..") do set "SWC_ROOT=%%~fI"
set "SWC_EXE=%SWC_ROOT%\SpecWithCode.exe"
if not exist "%SWC_EXE%" set "SWC_EXE=%SWC_ROOT%\SpecWithCode (Nightly).exe"
if not exist "%SWC_EXE%" goto missing
set "ELECTRON_RUN_AS_NODE=1"
set "STUDIO_CLI_NAME=specwithcode"
set "STUDIO_DESKTOP_CLI_LAUNCHER=1"
"%SWC_EXE%" "%SWC_RESOURCES%\server.asar\apps\server\dist\bin.mjs" %*
exit /b %ERRORLEVEL%
:missing
echo specwithcode: the SpecWithCode app in "%SWC_ROOT%" is incomplete. Reinstall it, then open it once. 1>&2
exit /b 127
