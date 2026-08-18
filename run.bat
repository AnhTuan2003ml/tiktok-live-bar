@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "ROOT=%~dp0"
set "BRIDGE_DIR=%ROOT%TikTokBridge"
set "BRIDGE_PORT=3100"
set "CONTROL_EDGE_SCRIPT=%ROOT%scripts\open-control-edge.ps1"

REM Goi mang sang may khac co the kem san Node.js trong thu muc runtime.
set "PORTABLE_NODE=%ROOT%runtime\node.exe"
set "USE_PORTABLE_NODE="
if exist "%PORTABLE_NODE%" (
    set "PATH=%ROOT%runtime;%PATH%"
    set "USE_PORTABLE_NODE=1"
)
set "LICENSE_NODE=node"
if defined USE_PORTABLE_NODE set "LICENSE_NODE=%PORTABLE_NODE%"

echo =======================================
echo     KHOI DONG TISO LIVE
echo =======================================
echo.

if not defined USE_PORTABLE_NODE (
    where node >nul 2>&1
    if errorlevel 1 (
        echo [LOI] Khong tim thay Node.js.
        echo Hay cai Node.js 20 tro len: https://nodejs.org/
        goto :failed
    )
)

if not exist "%BRIDGE_DIR%\package.json" (
    echo [LOI] Khong tim thay TikTokBridge\package.json.
    goto :failed
)

if not exist "%BRIDGE_DIR%\node_modules\express\package.json" (
    echo [1/4] Dang cai dat thu vien Node.js...
    pushd "%BRIDGE_DIR%"
    if exist package-lock.json (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        popd
        echo [LOI] npm install khong thanh cong.
        goto :failed
    )
    popd
) else (
    echo [1/4] Thu vien Node.js da san sang.
)

pushd "%BRIDGE_DIR%"
for /f "usebackq delims=" %%p in (`"%LICENSE_NODE%" -e "const e=require('./src/config/environment');e.loadEnvironmentFile();process.stdout.write(String(e.getServerSettings().port))"`) do set "BRIDGE_PORT=%%p"
popd
set "CONTROL_URL=http://127.0.0.1:%BRIDGE_PORT%/control.html"
set "ACTIVATE_URL=http://127.0.0.1:%BRIDGE_PORT%/activate.html"

call :bridge_is_ready
if defined BRIDGE_READY (
    echo [2/4] TikTok Bridge dang chay san tren cong %BRIDGE_PORT%.
    goto :check_license
)

set "PORT_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%BRIDGE_PORT% .*LISTENING" 2^>nul') do if not defined PORT_PID set "PORT_PID=%%a"
if defined PORT_PID (
    echo [LOI] Cong %BRIDGE_PORT% dang bi chuong trinh khac su dung ^(PID %PORT_PID%^).
    echo Launcher se KHONG tu tat chuong trinh khac de tranh mat du lieu.
    echo Hay dong chuong trinh do, sau do chay lai run.bat.
    goto :failed
)

echo [2/4] Dang khoi dong TikTok Bridge...
if defined USE_PORTABLE_NODE (
    start "TikTok Bridge" /D "%BRIDGE_DIR%" cmd /k ""%PORTABLE_NODE%" server.js"
) else (
    start "TikTok Bridge" /D "%BRIDGE_DIR%" cmd /k "npm start"
)

set "BRIDGE_READY="
for /l %%i in (1,1,30) do (
    if not defined BRIDGE_READY (
        call :bridge_is_ready
        if not defined BRIDGE_READY ping 127.0.0.1 -n 2 >nul
    )
)
if not defined BRIDGE_READY (
    echo [LOI] TikTok Bridge khong san sang sau 30 giay.
    echo Hay xem loi trong cua so "TikTok Bridge".
    goto :failed
)

:check_license
echo [3/4] Dang kiem tra ban quyen...
call :is_licensed
if "%LICENSED%"=="1" (
    echo       Ban quyen hop le.
    goto :launch_game
)

echo.
echo ==========================================================
echo   CHUA KICH HOAT BAN QUYEN
echo ==========================================================
echo   Dang mo giao dien kich hoat. Hay chon goi thoi han,
echo   bam "Gui ma" roi lien he nguoi ban de nhan ma kich hoat.
echo   Kich hoat xong, Game se tu khoi dong.
echo   ^(Dong cua so nay neu muon huy.^)
echo.
if exist "%CONTROL_EDGE_SCRIPT%" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%CONTROL_EDGE_SCRIPT%" -Url "%ACTIVATE_URL%"
) else (
    start "" msedge.exe --app="%ACTIVATE_URL%" --start-maximized
)

:wait_activation
ping 127.0.0.1 -n 6 >nul
call :is_licensed
if not "%LICENSED%"=="1" goto :wait_activation
echo   Da kich hoat thanh cong.

:launch_game
echo [4/4] Dang khoi dong Game tren cong %BRIDGE_PORT%...
if exist "%ROOT%Build\TISO.exe" (
    start "" "%ROOT%Build\TISO.exe" -bridgePort %BRIDGE_PORT%
) else if exist "%ROOT%Build\TIKTOK_LIVE_BAR.exe" (
    start "" "%ROOT%Build\TIKTOK_LIVE_BAR.exe" -bridgePort %BRIDGE_PORT%
) else (
    echo [CANH BAO] Khong tim thay file Game trong thu muc Build.
    echo Chay build.bat sau khi cai Unity 6, hoac mo UnityProject bang Unity Hub.
)

:open_control
if exist "%CONTROL_EDGE_SCRIPT%" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%CONTROL_EDGE_SCRIPT%" -Url "%CONTROL_URL%"
) else (
    start "" msedge.exe --app="%CONTROL_URL%" --start-maximized
)
echo.
echo Da khoi dong. Control Panel Edge: %CONTROL_URL%
exit /b 0

:is_licensed
REM Dat LICENSED=1 khi ban quyen hop le, nguoc lai de trong.
set "LICENSED="
pushd "%BRIDGE_DIR%"
"%LICENSE_NODE%" check-license.js
if not errorlevel 1 set "LICENSED=1"
popd
exit /b 0

:bridge_is_ready
set "BRIDGE_READY="
for /f "usebackq delims=" %%r in (`powershell -NoProfile -Command "try { $h = Invoke-RestMethod -Uri '%CONTROL_URL:control.html=api/health%' -TimeoutSec 2; if ($h.status -eq 'ok' -and $h.appId -eq 'tiso-bridge') { 'YES' } } catch {}"`) do set "BRIDGE_READY=%%r"
exit /b 0

:failed
echo.
pause
exit /b 1
