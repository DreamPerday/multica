@echo off
rem Fake `dsh` for bridge tests. Shaped like a real launcher shim — a quoted
rem executable, a fixed script argument, then %* — so the bridge's shim parser
rem is exercised too. Both paths come from the environment the test sets.
"%DSH_BRIDGE_FAKE_NODE%" "%DSH_BRIDGE_FAKE_SCRIPT%" %*
exit /b %ERRORLEVEL%
