param(
    [Parameter(Mandatory=$true)]
    [string]$Url
)

# Mở TISO Control Panel bằng Microsoft Edge ở chế độ ứng dụng:
# một cửa sổ duy nhất, không thanh tab, không thanh địa chỉ.

function Find-Edge {
    $candidates = @()
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += (Join-Path $base 'Microsoft\Edge\Application\msedge.exe') }
    }
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path) { return $path }
    }

    # Dự phòng: đọc đường dẫn Edge từ registry App Paths.
    $appPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    )
    foreach ($key in $appPaths) {
        try {
            $value = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
            if ($value -and (Test-Path -LiteralPath $value)) { return $value }
        } catch { }
    }

    $command = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

$edge = Find-Edge
if (-not $edge) {
    Write-Host '[CANH BAO] Khong tim thay Microsoft Edge. Mo bang trinh duyet mac dinh.'
    Start-Process $Url
    exit 0
}

$appArg = "--app=$Url"
$profileDir = Join-Path $env:LOCALAPPDATA 'TISO\EdgeControlProfile'

# Đã có cửa sổ Control Panel? Đưa nó lên trước thay vì mở thêm cửa sổ mới.
$existing = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($appArg) })

if ($existing.Count -gt 0) {
    $window = $null
    foreach ($item in $existing) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { $window = $process; break }
    }

    if ($window) {
        try {
            if (-not ('TisoWindow' -as [type])) {
                Add-Type -Namespace Tiso -Name Window -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
'@ -ErrorAction Stop
            }
            [Tiso.Window]::ShowWindowAsync($window.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
            [Tiso.Window]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
        } catch { }
        Write-Host 'Control Panel dang mo san tren Edge.'
        exit 0
    }
}

New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
Start-Process -FilePath $edge -ArgumentList @(
    $appArg,
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=msEdgeSidebarV2,EdgeCollections',
    '--start-maximized'
)
Write-Host "Da mo Control Panel bang Edge: $Url"
