' Cria um atalho "SPhoto" na Area de Trabalho apontando para ESTE pacote,
' onde quer que ele tenha sido copiado. Basta dar um duplo-clique neste arquivo.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = sh.SpecialFolders("Desktop")

Set lnk = sh.CreateShortcut(desktop & "\SPhoto.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & pasta & "\iniciar-tudo.vbs"""
lnk.WorkingDirectory = pasta
lnk.IconLocation = "C:\Windows\System32\imageres.dll,105"
lnk.Description = "Inicia o SPhoto (servidor, camera, plataforma e interfaces)"
lnk.Save

MsgBox "Pronto! O atalho 'SPhoto' foi criado na Area de Trabalho." & vbCrLf & _
       "Use ele pra ligar o SPhoto (servidor + camera + plataforma + telas).", _
       64, "SPhoto"
