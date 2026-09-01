' Run something with no window, in the owner's own session.
'
' ## Why this exists
'
' Task Scheduler launches Operator's three background pieces - the server and
' the two Vite dev servers - and each one is a .cmd, so each one puts a console
' window on the desktop. The owner's words: "can we have like a headless thing
' where i dont have a shit ton of cmd prompts going on".
'
' ## Why NOT "run whether user is logged on or not"
'
' That is the obvious answer and it is wrong here. It moves the task into
' session 0, which genuinely has no window - and also cannot touch the desktop
' at all. `focus_operator` brings Operator's window to the front on screen 2,
' which is the whole point of the clap gesture, and a session 0 process cannot
' do it. The feature would break in a way that looks like the summon being
' flaky rather than the task being isolated.
'
' So: still interactive, still the owner's session, just with the window style
' set to hidden. WshShell.Run's second argument is that style; 0 is hidden.
'
' ## Why VBScript, of all things
'
' Because it is the only launcher Windows ships that can start a process with
' NO console allocated at all. `cmd /c` and `powershell -WindowStyle Hidden`
' both flash a window first - briefly, but on every start, and PowerShell then
' spawns its own child console anyway. wscript.exe allocates none.
'
'   wscript.exe //B "hidden.vbs" "<command to run>"

Option Explicit

Dim args, shell, command

Set args = WScript.Arguments
If args.Count = 0 Then
    WScript.Quit 2
End If

command = args(0)

Set shell = CreateObject("WScript.Shell")

' 0 = hidden window. False = do not wait; the scheduled task should report
' "started" rather than sitting open for the lifetime of the server, which
' would make every task look permanently Running and break /End.
shell.Run command, 0, False

WScript.Quit 0
