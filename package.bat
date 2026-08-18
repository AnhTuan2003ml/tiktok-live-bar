@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

REM ============================================================
REM  Dong goi TISO Live thanh mot thu muc chay duoc tren may khac.
REM  Goi gom: game da build, TikTok Bridge (server), nhac, nen,
REM  tai lieu va run.bat. Tuy chon kem luon Node.js runtime.
REM ============================================================

set "ROOT=%~dp0"
set "DIST=%ROOT%dist"
set "NAME=TISO-Live-Windows"
set "STAGE=%DIST%\%NAME%"
set "BRIDGE_DIR=%ROOT%TikTokBridge"
set "INCLUDE_NODE=1"
set "MAKE_ZIP=1"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="/nonode" set "INCLUDE_NODE=0"
if /i "%~1"=="/nozip"  set "MAKE_ZIP=0"
if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-h" goto :usage
shift
goto :parse_args
:args_done

echo =======================================
echo     DONG GOI TISO LIVE
echo =======================================
echo.

REM ---------- 1. Kiem tra game da build ----------
if not exist "%ROOT%Build\TISO.exe" (
    echo [1/6] Chua co Build\TISO.exe - dang build game...
    call "%ROOT%build.bat"
    if errorlevel 1 (
        echo [LOI] Build game khong thanh cong. Hay chay build.bat va xem loi truoc.
        goto :failed
    )
) else (
    echo [1/6] Game da build san: Build\TISO.exe
)

REM ---------- 2. Thu vien Node cho Bridge ----------
if not exist "%BRIDGE_DIR%\node_modules\express\package.json" (
    echo [2/6] Dang cai thu vien Node cho Bridge...
    pushd "%BRIDGE_DIR%"
    if exist package-lock.json (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        popd
        echo [LOI] Khong cai duoc thu vien Node.
        goto :failed
    )
    popd
) else (
    echo [2/6] Thu vien Node da san sang.
)

REM ---------- 3. Don thu muc dich ----------
echo [3/6] Dang don thu muc dich...
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" 2>nul
if not exist "%STAGE%" (
    echo [LOI] Khong tao duoc thu muc "%STAGE%".
    goto :failed
)

REM ---------- 4. Sao chep noi dung ----------
echo [4/6] Dang sao chep game, server va tai nguyen...

REM Build\DJ_MUSIC co the la junction tro ve DJ_MUSIC goc - bo qua de khong trung lap.
robocopy "%ROOT%Build" "%STAGE%\Build" /E /NFL /NDL /NJH /NJS /NP /XJ /XD "DJ_MUSIC" >nul
if errorlevel 8 goto :copy_failed

robocopy "%BRIDGE_DIR%" "%STAGE%\TikTokBridge" /E /NFL /NDL /NJH /NJS /NP /XJ ^
    /XD "test" ".git" /XF ".env" "*.log" "*.tmp.js" >nul
if errorlevel 8 goto :copy_failed

for %%D in (DJ_MUSIC DJ_VIDEO LiveAssets Documentation scripts) do (
    if exist "%ROOT%%%D" (
        robocopy "%ROOT%%%D" "%STAGE%\%%D" /E /NFL /NDL /NJH /NJS /NP /XJ >nul
        if errorlevel 8 goto :copy_failed
    )
)

for %%F in (run.bat README.md README-BAT-DAU.txt LICENSE) do (
    if exist "%ROOT%%%F" copy /y "%ROOT%%%F" "%STAGE%\%%F" >nul
)

REM Huong dan doc dau tien cho nguoi nhan goi.
if exist "%ROOT%scripts\package-readme.txt" copy /y "%ROOT%scripts\package-readme.txt" "%STAGE%\DOC-DAU-TIEN.txt" >nul

REM ---------- 5. Cau hinh sach cho may khac ----------
echo [5/6] Dang lam sach cau hinh rieng tu...
if exist "%BRIDGE_DIR%\.env.example" copy /y "%BRIDGE_DIR%\.env.example" "%STAGE%\TikTokBridge\.env" >nul
node "%ROOT%scripts\sanitize-package-config.js" "%STAGE%"
if errorlevel 1 (
    echo [LOI] Khong lam sach duoc cau hinh trong goi.
    goto :failed
)

if "%INCLUDE_NODE%"=="1" (
    for /f "delims=" %%N in ('where node 2^>nul') do (
        if not defined NODE_EXE set "NODE_EXE=%%N"
    )
    if defined NODE_EXE (
        mkdir "%STAGE%\runtime" 2>nul
        copy /y "!NODE_EXE!" "%STAGE%\runtime\node.exe" >nul
        echo       Da kem Node.js runtime - may khac khong can cai Node.
    ) else (
        echo       Khong tim thay node.exe de kem theo; may khac se can cai Node 20+.
    )
)

REM ---------- 6. Nen ZIP ----------
if "%MAKE_ZIP%"=="1" (
    echo [6/6] Dang nen ZIP...
    if exist "%DIST%\%NAME%.zip" del /f /q "%DIST%\%NAME%.zip"
    powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%DIST%\%NAME%.zip' -CompressionLevel Optimal"
    if errorlevel 1 (
        echo [LOI] Khong nen duoc ZIP. Thu muc "%STAGE%" van dung duoc.
        goto :failed
    )
) else (
    echo [6/6] Bo qua buoc nen ZIP theo tuy chon /nozip.
)

echo.
echo =======================================
echo     DONG GOI XONG
echo =======================================
echo Thu muc: %STAGE%
if "%MAKE_ZIP%"=="1" echo File ZIP: %DIST%\%NAME%.zip
echo.
echo Cach dung tren may khac:
echo   1. Chep thu muc (hoac giai nen ZIP) ra o dia bat ky.
echo   2. Nhap dup run.bat - launcher tu mo Bridge, Game va Control Panel tren Edge.
echo.
exit /b 0

:copy_failed
echo [LOI] Sao chep that bai (robocopy).
goto :failed

:usage
echo Cach dung: package.bat [/nonode] [/nozip]
echo   /nonode  Khong kem Node.js runtime vao goi.
echo   /nozip   Chi tao thu muc, khong nen ZIP.
exit /b 0

:failed
echo.
pause
exit /b 1
