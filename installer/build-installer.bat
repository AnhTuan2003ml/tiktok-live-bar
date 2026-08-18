@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "ROOT=%~dp0.."
set "ISS=%~dp0TISO_Setup.iss"
set "OUTPUT=%ROOT%\dist"
set "GAME_EXE=%ROOT%\Build\TISO.exe"
set "BRIDGE_PKG=%ROOT%\TikTokBridge\package.json"

if not exist "%GAME_EXE%" (
  echo [LOI] Chua co Build\TISO.exe. Hay build game truoc.
  exit /b 1
)
if not exist "%BRIDGE_PKG%" (
  echo [LOI] Thieu TikTokBridge\package.json.
  exit /b 1
)

set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo [LOI] Khong tim thay Inno Setup 6. Hay cai Inno Setup truoc.
  exit /b 1
)

if not exist "%OUTPUT%" mkdir "%OUTPUT%"
"%ISCC%" "%ISS%"
