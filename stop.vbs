' Sleep Tracker — Stop the running app
' Double-click to kill all pythonw.exe processes running in this project.

Dim shell, fso, scriptDir

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

' Kill pythonw.exe processes that have app.py in their command line
shell.Run "taskkill /f /fi " & Chr(34) & "IMAGENAME eq pythonw.exe" & Chr(34) & _
          " /fi " & Chr(34) & "WINDOWTITLE eq app.py" & Chr(34), 0, True

' Also kill any regular python.exe running app.py from our project dir
shell.Run "taskkill /f /fi " & Chr(34) & "IMAGENAME eq python.exe" & Chr(34) & _
          " /fi " & Chr(34) & "WINDOWTITLE eq app.py" & Chr(34), 0, True

' Cleanup marker
Dim markerFile
markerFile = scriptDir & "\.last_started"
If fso.FileExists(markerFile) Then
    fso.DeleteFile markerFile
End If
