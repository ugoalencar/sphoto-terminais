' Resolve a pasta onde este .vbs esta (nao fixo em C:\sphoto) - assim continua
' funcionando se a pasta sphoto for copiada pra outro lugar/computador.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pastaScript = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c """ & pastaScript & "\iniciar-server.bat""", 0, False
