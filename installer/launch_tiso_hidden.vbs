Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(base)
cmd = "cmd /c \"" & root & "\\run.bat\""
shell.CurrentDirectory = root
shell.Run cmd, 0, False
