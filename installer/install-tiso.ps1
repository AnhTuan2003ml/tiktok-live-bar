# ============================================================
#  TISO Live - cai dat va cap nhat tu GitHub Releases
#
#  Dung cho ca hai viec:
#    - Cai moi : chon thu muc -> tai ban moi nhat -> giai nen -> tao shortcut
#    - Cap nhat: tai ban moi nhat -> dong app -> ghi de -> chay lai
#
#  Vi du:
#    powershell -ExecutionPolicy Bypass -File install-tiso.ps1
#    powershell -ExecutionPolicy Bypass -File install-tiso.ps1 -InstallDir "D:\TISO" -Silent
#    powershell -ExecutionPolicy Bypass -File install-tiso.ps1 -InstallDir "D:\TISO" -Update -Launch
# ============================================================

[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [switch]$Silent,        # khong hoi gi, dung InstallDir da truyen
    [switch]$Update,        # che do cap nhat: giu cau hinh, dong app truoc khi ghi de
    [switch]$Launch,        # chay run.bat sau khi xong
    [switch]$NoShortcut,
    [string]$Repo = 'AnhTuan2003ml/tiktok-live-bar'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppName = 'TISO Live Control'
# Nhung thu thuoc ve may nguoi dung - cap nhat khong duoc ghi de.
$PreservePaths = @(
    'TikTokBridge\.env',
    'TikTokBridge\config\operator.json',
    'TikTokBridge\config\observed-gifts.json',
    'TikTokBridge\config\master.json',
    'TikTokBridge\config\.license.dat',
    'TikTokBridge\config\.activation.dat',
    'DJ_MUSIC',
    'DJ_VIDEO',
    'LiveAssets'
)

function Write-Step { param([string]$Text) Write-Host "  $Text" }
function Write-Title { param([string]$Text) Write-Host ""; Write-Host "== $Text ==" -ForegroundColor Cyan }

function Get-LatestRelease {
    param([string]$Repository)
    $uri = "https://api.github.com/repos/$Repository/releases/latest"
    $headers = @{ 'User-Agent' = 'TISO-Installer'; 'Accept' = 'application/vnd.github+json' }
    try {
        return Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30
    } catch {
        throw "Khong lay duoc thong tin ban phat hanh moi nhat tu GitHub. " +
              "Hay kiem tra ket noi mang, hoac ban phat hanh van con o che do Draft nen chua tai duoc. ($($_.Exception.Message))"
    }
}

function Select-InstallFolder {
    param([string]$Current)
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Chon thu muc cai dat $AppName"
    $dialog.ShowNewFolderButton = $true
    if ($Current -and (Test-Path $Current)) { $dialog.SelectedPath = $Current }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
    return ''
}

function Stop-TisoProcesses {
    param([string]$TargetDir)
    $stopped = @()

    # CHI dong game nam trong dung thu muc cai dat. Neu khong loc theo duong dan,
    # mot ban TISO khac dang chay tren may (vi du ban dang LIVE) se bi dong oan.
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name='TISO.exe'" -ErrorAction SilentlyContinue)) {
        $exePath = [string]$item.ExecutablePath
        if (-not $exePath) { continue }
        if ($TargetDir -and -not $exePath.StartsWith($TargetDir, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop; $stopped += "TISO.exe (PID $($item.ProcessId))" } catch { }
    }

    # Bridge chay bang node server.js - chi dong tien trinh thuoc dung thu muc cai dat.
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        $line = [string]$item.CommandLine
        if ($line -and $line -match 'server\.js' -and $TargetDir -and $line -like "*$TargetDir*") {
            try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop; $stopped += "node.exe (PID $($item.ProcessId))" } catch { }
        }
    }

    if ($stopped.Count -gt 0) {
        Write-Step "Da dong: $($stopped -join ', ')"
        Start-Sleep -Seconds 2
    }
}

function Backup-UserData {
    param([string]$TargetDir, [string]$BackupDir)
    $saved = @()
    foreach ($relative in $PreservePaths) {
        $source = Join-Path $TargetDir $relative
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $destination = Join-Path $BackupDir $relative
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        } else {
            # File license bi dat thuoc tinh an/he thong, go truoc khi chep.
            try { attrib -h -s "$source" 2>$null | Out-Null } catch { }
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
        $saved += $relative
    }
    return $saved
}

function Restore-UserData {
    param([string]$TargetDir, [string]$BackupDir, [string[]]$Saved)
    foreach ($relative in $Saved) {
        $source = Join-Path $BackupDir $relative
        if (-not (Test-Path -LiteralPath $source)) { continue }
        $destination = Join-Path $TargetDir $relative
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
}

function New-TisoShortcut {
    param([string]$LinkPath, [string]$TargetDir)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($LinkPath)
    $shortcut.TargetPath = Join-Path $TargetDir 'run.bat'
    $shortcut.WorkingDirectory = $TargetDir
    $shortcut.Description = "$AppName - mo Bridge, Game va Control Panel"
    $gameExe = Join-Path $TargetDir 'Build\TISO.exe'
    if (Test-Path -LiteralPath $gameExe) { $shortcut.IconLocation = $gameExe }
    $shortcut.Save()
}

# ------------------------------------------------------------
#  1. Thu muc cai dat
# ------------------------------------------------------------
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "     $AppName - CAI DAT / CAP NHAT" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

if (-not $InstallDir) {
    $default = Join-Path $env:LOCALAPPDATA 'TISO Live'
    if ($Silent) {
        $InstallDir = $default
    } else {
        Write-Title "Chon thu muc cai dat"
        Write-Step "Mac dinh: $default"
        $InstallDir = Select-InstallFolder -Current $default
        if (-not $InstallDir) {
            Write-Step "Da huy chon thu muc, dung mac dinh: $default"
            $InstallDir = $default
        }
    }
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
Write-Step "Thu muc cai dat: $InstallDir"

# ------------------------------------------------------------
#  2. Ban phat hanh moi nhat
# ------------------------------------------------------------
Write-Title "Kiem tra ban phat hanh moi nhat"
$release = Get-LatestRelease -Repository $Repo
$asset = $release.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { throw "Ban phat hanh $($release.tag_name) khong co file ZIP nao de tai." }

Write-Step "Phien ban : $($release.tag_name)"
Write-Step "File      : $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"

# ------------------------------------------------------------
#  3. Tai ZIP
# ------------------------------------------------------------
Write-Title "Tai ve"
$tempDir = Join-Path $env:TEMP ("tiso-setup-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipPath = Join-Path $tempDir $asset.name

try {
    $progress = $ProgressPreference
    $ProgressPreference = 'Continue'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -TimeoutSec 1800 -Headers @{ 'User-Agent' = 'TISO-Installer' }
    $ProgressPreference = $progress
    Write-Step "Da tai: $([math]::Round((Get-Item $zipPath).Length / 1MB, 1)) MB"

    # ------------------------------------------------------------
    #  4. Dong app dang chay roi giai nen, ghi de
    # ------------------------------------------------------------
    Write-Title "Cai dat"
    Stop-TisoProcesses -TargetDir $InstallDir

    $backupDir = Join-Path $tempDir 'giu-lai'
    $saved = @()
    if (Test-Path -LiteralPath $InstallDir) {
        $saved = @(Backup-UserData -TargetDir $InstallDir -BackupDir $backupDir)
        if ($saved.Count -gt 0) { Write-Step "Giu lai cau hinh nguoi dung: $($saved -join ', ')" }
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $extractDir = Join-Path $tempDir 'giai-nen'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    # Goi co the boc them mot lop thu muc - lay dung lop chua run.bat.
    $root = $extractDir
    if (-not (Test-Path (Join-Path $root 'run.bat'))) {
        $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'run.bat') } | Select-Object -First 1
        if ($inner) { $root = $inner.FullName }
    }

    Write-Step "Dang ghi de vao thu muc cai dat..."
    $robocopyLog = & robocopy $root $InstallDir /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2
    if ($LASTEXITCODE -ge 8) { throw "Ghi de that bai (robocopy tra ma $LASTEXITCODE)." }

    if ($saved.Count -gt 0) {
        Restore-UserData -TargetDir $InstallDir -BackupDir $backupDir -Saved $saved
        Write-Step "Da tra lai cau hinh nguoi dung."
    }

    # ------------------------------------------------------------
    #  5. Shortcut
    # ------------------------------------------------------------
    if (-not $NoShortcut) {
        Write-Title "Tao shortcut"
        $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
        New-TisoShortcut -LinkPath $desktop -TargetDir $InstallDir
        Write-Step "Desktop   : $desktop"

        $startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
        New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
        $startMenu = Join-Path $startMenuDir "$AppName.lnk"
        New-TisoShortcut -LinkPath $startMenu -TargetDir $InstallDir
        Write-Step "Start Menu: $startMenu"
    }

    # Ghi lai phien ban da cai de app biet minh dang o ban nao.
    $versionInfo = [ordered]@{
        tag = $release.tag_name
        installed_at = (Get-Date).ToString('s')
        source = $asset.browser_download_url
    }
    $versionInfo | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'VERSION.json') -Encoding utf8

    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Green
    if ($Update) { Write-Host "     DA CAP NHAT XONG" -ForegroundColor Green }
    else { Write-Host "     DA CAI DAT XONG" -ForegroundColor Green }
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host "  Thu muc : $InstallDir"
    Write-Host "  Phien ban: $($release.tag_name)"
    Write-Host "  Mo app  : nhap dup shortcut tren Desktop, hoac chay run.bat"
    Write-Host ""

    if ($Launch) {
        Start-Process -FilePath (Join-Path $InstallDir 'run.bat') -WorkingDirectory $InstallDir
    }
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
