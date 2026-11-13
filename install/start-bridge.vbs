' agy-bridge silent launcher (no console window)
Option Explicit
Dim fso, shell, root, core, entry, nodeExe, p, probe, here
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here  = fso.GetParentFolderName(WScript.ScriptFullName)
root  = fso.GetParentFolderName(here)
core  = fso.BuildPath(root, "core")
entry = fso.BuildPath(core, "index.js")

If Not fso.FileExists(entry) Then
  MsgBox "bridge core not found: " & entry, 16, "agy-bridge"
  WScript.Quit 1
End If

' single instance: if /api/health already answers, do nothing
probe = ""
On Error Resume Next
Dim http
Set http = CreateObject("MSXML2.XMLHTTP.6.0")
http.Open "GET", "http://127.0.0.1:18925/api/health", False
http.Send
If http.Status = 200 Then probe = http.responseText
Set http = Nothing
On Error GoTo 0
If InStr(probe, """ok"":true") > 0 Then WScript.Quit 0

' 1) pinned path written by install.ps1
nodeExe = ""
Dim pin
pin = fso.BuildPath(here, "node-path.txt")
If fso.FileExists(pin) Then
  Dim ts, line
  Set ts = fso.OpenTextFile(pin, 1, False, -1)
  If Not ts.AtEndOfStream Then line = Trim(ts.ReadLine)
  ts.Close
  ' only trust a pinned real executable; a .cmd shim does not survive detachment
  If line <> "" And fso.FileExists(line) Then
    If LCase(Right(line, 4)) <> ".cmd" And LCase(Right(line, 4)) <> ".bat" Then nodeExe = line
  End If
End If

' 2) fall back to PATH scan: node.exe first, then node.cmd
If nodeExe = "" Then
  On Error Resume Next
  Dim cand
  cand = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
  If fso.FileExists(cand) Then nodeExe = cand
  On Error GoTo 0
End If
If nodeExe = "" Then
  On Error Resume Next
  Dim names, nm
  names = Array("node.exe")
  For Each p In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
    If p <> "" Then
      For Each nm In names
        cand = fso.BuildPath(p, nm)
        If fso.FileExists(cand) Then
          nodeExe = cand
          Exit For
        End If
      Next
      If nodeExe <> "" Then Exit For
    End If
  Next
  On Error GoTo 0
End If
If nodeExe = "" Then
  On Error Resume Next
  Dim shims
  shims = Array("node.cmd", "node.bat")
  For Each p In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
    If p <> "" Then
      For Each nm In shims
        cand = fso.BuildPath(p, nm)
        If fso.FileExists(cand) Then
          nodeExe = cand
          Exit For
        End If
      Next
      If nodeExe <> "" Then Exit For
    End If
  Next
  On Error GoTo 0
End If

If nodeExe = "" Then
  MsgBox "node not found; cannot start agy-bridge." & vbCrLf & _
         "Install Node.js 24.5+, or re-run install.ps1.", 16, "agy-bridge"
  WScript.Quit 1
End If

' a .cmd/.bat shim must run through cmd.exe, a real .exe can be spawned directly
If LCase(Right(nodeExe, 4)) = ".cmd" Or LCase(Right(nodeExe, 4)) = ".bat" Then
  shell.CurrentDirectory = core
  shell.Run "cmd /c """ & nodeExe & """ """ & entry & """", 0, False
Else
  shell.CurrentDirectory = core
  shell.Run """" & nodeExe & """ """ & entry & """", 0, False
End If
