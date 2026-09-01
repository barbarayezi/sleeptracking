' Sleep Tracker — Silent Launcher
' Double-click this to start the app with no console window.
' Browser will open automatically after ~3 seconds.
' No crash auto-restart (use run.bat or scheduled task for that).

Dim shell, fso, scriptDir, logDir, logFile, timestamp

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = scriptDir & "\.logs"

' Ensure .logs directory exists
If Not fso.FolderExists(logDir) Then
    fso.CreateFolder(logDir)
End If

timestamp = Year(Now) & Right("0" & Month(Now), 2) & Right("0" & Day(Now), 2) & "_" & _
            Right("0" & Hour(Now), 2) & Right("0" & Minute(Now), 2) & Right("0" & Second(Now), 2)
logFile = logDir & "\app-" & timestamp & ".log"

Set shell = CreateObject("WScript.Shell")

' pythonw.exe → no console window
' No HEADLESS → browser auto-opens
shell.Run "pythonw.exe app.py", 0, False

' Write a marker so the user can find the process
Dim markerFile
markerFile = scriptDir & "\.last_started"
Set f = fso.CreateTextFile(markerFile, True)
f.WriteLine Now
f.WriteLine "pythonw.exe app.py (no console, browser auto-opened)"
f.Close
