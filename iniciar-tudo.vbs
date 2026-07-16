' Roda o executor unico (launcher.js) sem janela de terminal - e o alvo do
' atalho "SPhoto" da area de trabalho. Resolve a propria pasta, entao continua
' funcionando se a pasta sphoto for copiada pra outro lugar/computador
' (desde que o atalho aponte pra este arquivo no local real).

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pastaScript = fso.GetParentFolderName(WScript.ScriptFullName)

' Saida vai pra logs\launcher-boot.log - pega inclusive o caso do proprio
' node nao estar instalado (que nunca chegaria ao launcher.log).
comando = "cmd /c cd /d """ & pastaScript & """ && (if not exist logs mkdir logs) && node launcher.js >> logs\launcher-boot.log 2>&1"
WshShell.Run comando, 0, False
