#define MyAppName "TISO Live Control"
#define MyAppVersion "1.0.6"
#define MyAppPublisher "TISO"
#define MyAppExeName "run.bat"
#define MyGameExe "Build\\TISO.exe"

[Setup]
AppId={{D7DBA880-39E8-4F9E-8F16-6A2E6A0C1F7B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TISO Live Control
DefaultGroupName=TISO Live Control
DisableProgramGroupPage=no
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\dist
OutputBaseFilename=TISO_Live_Control_Setup
PrivilegesRequired=lowest

[Languages]
Name: "vietnamese"; MessagesFile: "compiler:Languages\Vietnamese.isl"

[Tasks]
Name: "desktopicon"; Description: "Tạo shortcut ngoài Desktop"; GroupDescription: "Shortcut:"; Flags: unchecked
Name: "launchafter"; Description: "Mở TISO sau khi cài xong"; GroupDescription: "Sau khi cài:"; Flags: checkedonce

[Files]
Source: "..\run.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README-BAT-DAU.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Documentation\*"; DestDir: "{app}\Documentation"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\DJ_VIDEO\*"; DestDir: "{app}\DJ_VIDEO"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\DJ_MUSIC\*"; DestDir: "{app}\DJ_MUSIC"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LiveAssets\*"; DestDir: "{app}\LiveAssets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\Build\*"; DestDir: "{app}\Build"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\TikTokBridge\*"; DestDir: "{app}\TikTokBridge"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "launch_tiso_hidden.vbs"; DestDir: "{app}\installer"; Flags: ignoreversion

[Icons]
Name: "{group}\Mở TISO Live"; Filename: "{app}\run.bat"; WorkingDir: "{app}"; IconFilename: "{app}\Build\TISO.exe"
Name: "{group}\Mở TISO Live (ẩn cửa sổ cmd)"; Filename: "{sys}\wscript.exe"; Parameters: '"{app}\installer\launch_tiso_hidden.vbs"'; WorkingDir: "{app}"; IconFilename: "{app}\Build\TISO.exe"
Name: "{group}\Hướng dẫn sử dụng"; Filename: "{app}\Documentation\HUONG_DAN_SU_DUNG.txt"
Name: "{commondesktop}\TISO Live Control"; Filename: "{app}\run.bat"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\Build\TISO.exe"

[Run]
Filename: "{app}\run.bat"; Description: "Mở TISO Live"; Flags: nowait postinstall skipifsilent; Tasks: launchafter
