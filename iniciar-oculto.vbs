' Executa um .bat desta mesma pasta sem nenhuma janela visivel (o proprio .bat
' cuida do seu log em logs\ - ver camera.bat/start.bat) - usado no lugar de
' "start" quando o monitor.html ja cobre a visibilidade de status, entao a
' janela do terminal deixa de ser necessaria.
' Uso: wscript iniciar-oculto.vbs nome-do-arquivo.bat

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pastaScript = fso.GetParentFolderName(WScript.ScriptFullName)

nomeArquivo = WScript.Arguments(0)

WshShell.Run "cmd /c """ & pastaScript & "\" & nomeArquivo & """", 0, False
