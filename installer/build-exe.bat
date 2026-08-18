@echo off
setlocal EnableExtensions
chcp 65001 >nul
REM Build trinh cai dat TISO_Live_Setup.exe, kem cacert.pem de HTTPS chay tren moi may.
set "ROOT=%~dp0.."
for /f "usebackq delims=" %%c in (`python -c "import certifi;print(certifi.where())"`) do set "CACERT=%%c"
if not exist "%CACERT%" (
  echo [LOI] Khong tim thay certifi cacert.pem. Chay: pip install certifi
  exit /b 1
)
python -m PyInstaller --onefile --windowed --name TISO_Live_Setup ^
  --add-data "%CACERT%;." ^
  --distpath "%ROOT%\dist" --workpath "%TEMP%\tiso-pyi" --specpath "%TEMP%\tiso-pyi" ^
  "%~dp0tiso_installer.py"
echo Da build: %ROOT%\dist\TISO_Live_Setup.exe
