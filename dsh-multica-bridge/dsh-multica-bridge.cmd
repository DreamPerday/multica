@echo off
setlocal DisableDelayedExpansion

rem Launcher for the Multica / DeepSeek Harness bridge.
rem
rem Multica's dsh provider launches "<command> --profile multica --stdio", so
rem this shim is the executable it resolves on PATH. The argv is ignored by
rem bridge.mjs -- the bridge process itself is the protocol endpoint.
rem
rem Keep this file pure ASCII: cmd.exe reads it under the OEM codepage, and a
rem non-ASCII byte sequence here makes it mis-parse the lines that follow.
rem
rem node.exe is not on the system PATH on DSH Desktop machines: DSH ships its
rem own copy inside its per-user runtime directory and only injects it into the
rem PATH of processes it spawns. A daemon started by Multica is not one of
rem them, so both locations are tried.

set "BRIDGE_DIR=%~dp0"
set "NODE_EXE="

rem 1) A node already on PATH wins.
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"

rem 2) DSH Desktop's bundled node, newest runtime installation first.
rem    for /d only wildcards the final path component, so the runtime id is
rem    expanded first and the rest of the path appended per candidate.
if not defined NODE_EXE (
    for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
        if exist "%%D\dependencies\node\bin\node.exe" set "NODE_EXE=%%D\dependencies\node\bin\node.exe"
    )
)

if not defined NODE_EXE (
    echo [dsh-bridge] node.exe not found on PATH or under the DSH runtimes directory 1>&2
    exit /b 127
)

"%NODE_EXE%" "%BRIDGE_DIR%bridge.mjs" %*
exit /b %ERRORLEVEL%
