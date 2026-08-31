// Window operations for Operator, as a small native program.
//
// ## Why this exists
//
// The summon used to spawn PowerShell and compile these declarations with
// Add-Type on every call: ~320ms to start the shell and ~450ms to run the C#
// compiler, before a single Win32 call happened, for work that takes
// microseconds. That is the whole of what kept being reported as sluggish.
//
// An attempt at a long-lived PowerShell failed for a reason worth recording:
// `powershell -Command -` buffers stdin until EOF rather than acting as a
// REPL, so nothing that writes commands to its stdin can work regardless of
// framing.
//
// Compiling the same code instead removes the problem rather than working
// around it. A spawned exe starts in a few milliseconds, needs no lifecycle
// management, no request queue and no fallback path — three of the four things
// that made the long-lived attempt fragile.
//
// Built with the csc.exe that ships with Windows (.NET Framework 4). No SDK,
// no package, no dependency — the same bargain `render.mjs` struck with Edge.
//
// ## What it does, and only what it does
//
//   OperatorWin.exe summon <titleFragment> <screenX> <screenY> <screenW> <screenH> <pause>
//
// Finds a visible window whose title contains the fragment, brings it to the
// front, moves it to the given screen if it is not already there, and makes it
// fullscreen. Prints one line describing what happened.
//
// It takes coordinates rather than a screen index on purpose: the caller
// already knows the display layout and caches it, and a program that resolves
// screens itself would be a second place for that to be wrong.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Speech.Recognition;

public class OperatorWin
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    public struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr h, IntPtr p);

    const byte VK_F11 = 0x7A;
    const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    const int SW_RESTORE = 9;
    const int SW_MAXIMIZE = 3;
    const uint KEYUP = 2;

    static IntPtr found;
    static string want;

    static string TitleOf(IntPtr h)
    {
        var b = new StringBuilder(400);
        GetWindowText(h, b, 400);
        return b.ToString();
    }

    static bool Check(IntPtr h, IntPtr p)
    {
        if (!IsWindowVisible(h)) return true;
        string t = TitleOf(h);
        if (t.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
        return true;
    }

    /// Every visible top-level window, not just each process's main one — a
    /// browser has many, and an installed web app is not the main one.
    static IntPtr ByTitle(string fragment)
    {
        want = fragment;
        found = IntPtr.Zero;
        EnumWindows(Check, IntPtr.Zero);
        return found;
    }

    static void Tap(byte key)
    {
        keybd_event(key, 0, 0, 0);
        keybd_event(key, 0, KEYUP, 0);
    }

    /// <summary>
    /// Actually get the window to the front, and say whether it worked.
    ///
    /// SetForegroundWindow fails SILENTLY for a process that does not already
    /// own the foreground — which a server spawning a helper never does. That
    /// is not cosmetic here: every keystroke below goes to whatever IS
    /// foreground, so an F11 meant for Operator was landing somewhere else
    /// entirely. The window stayed the size it was, the tool reported
    /// "sent-f11", and both were true.
    ///
    /// AttachThreadInput is the documented way round it: attach to the input
    /// queue of the thread that currently owns the foreground, which makes this
    /// process eligible, then detach. Verified rather than assumed — the caller
    /// needs to know, because sending keys to the wrong window is worse than
    /// doing nothing.
    /// </summary>
    static bool Raise(IntPtr h)
    {
        SwitchToThisWindow(h, true);
        SetForegroundWindow(h);
        if (GetForegroundWindow() == h) return true;

        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint ours = GetCurrentThreadId();
        if (fgThread != 0 && fgThread != ours) AttachThreadInput(ours, fgThread, true);
        try
        {
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
        finally
        {
            if (fgThread != 0 && fgThread != ours) AttachThreadInput(ours, fgThread, false);
        }

        for (int i = 0; i < 10; i++)
        {
            if (GetForegroundWindow() == h) return true;
            Thread.Sleep(30);
        }
        return false;
    }

    /// <summary>
    /// Listen for one spoken phrase and print it. Speech in, phase 4 of the
    /// presence layer.
    ///
    ///   OperatorWin.exe listen [seconds]
    ///
    /// Uses the recogniser that ships with Windows via System.Speech. That is
    /// worse than Whisper at accuracy and needs NOTHING installed — no binary,
    /// no 150MB model, no Python — which is why it goes first: it proves the
    /// whole path (clap, capture, transcribe, act) today, and whisper.cpp can
    /// swap in behind the same one-line-of-text interface once real use has
    /// shaped what that interface should be. See ADR 0015's 2026-08-31
    /// amendment.
    ///
    /// **Dictation grammar, not a command list.** A command grammar is far more
    /// accurate and would mean deciding in advance every sentence Operator can
    /// be told — which is the opposite of talking to it. The text goes to a
    /// model that is good at ambiguity; the recogniser does not need to be.
    ///
    /// Nothing is recorded or written. The audio is consumed by the recogniser
    /// and one line of text comes out.
    /// </summary>
    static int Listen(int seconds)
    {
        using (var engine = new SpeechRecognitionEngine())
        {
            try
            {
                engine.SetInputToDefaultAudioDevice();
            }
            catch (Exception e)
            {
                Console.WriteLine("ERR|no microphone: " + e.Message);
                return 1;
            }

            engine.LoadGrammar(new DictationGrammar());
            // Silence ends the phrase, so a short sentence returns immediately
            // rather than always waiting out the full window.
            engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(900);
            engine.InitialSilenceTimeout = TimeSpan.FromSeconds(seconds);

            RecognitionResult result = null;
            try
            {
                result = engine.Recognize(TimeSpan.FromSeconds(seconds));
            }
            catch (Exception e)
            {
                Console.WriteLine("ERR|" + e.Message);
                return 1;
            }

            if (result == null || string.IsNullOrWhiteSpace(result.Text))
            {
                Console.WriteLine("NOSPEECH");
                return 1;
            }
            // Confidence is printed rather than used as a gate: a threshold
            // here would silently drop phrases, and the caller can see the
            // number and decide.
            Console.WriteLine("TEXT|" + result.Confidence.ToString("0.00") + "|" + result.Text);
            return 0;
        }
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.WriteLine("ERR|no command"); return 2; }

        if (args[0] == "listen")
        {
            int secs = args.Length > 1 ? int.Parse(args[1]) : 8;
            return Listen(secs);
        }

        if (args[0] != "summon") { Console.WriteLine("ERR|unknown command"); return 2; }
        if (args.Length < 6) { Console.WriteLine("ERR|summon needs title x y w h [pause]"); return 2; }

        string fragment = args[1];
        int sx = int.Parse(args[2]);
        int sy = int.Parse(args[3]);
        int sw = int.Parse(args[4]);
        int sh = int.Parse(args[5]);
        bool pause = args.Length > 6 && args[6] == "1";

        // A window reports an empty title for a moment while it enters or
        // leaves fullscreen, so a summon arriving during another one's
        // transition would otherwise find nothing.
        IntPtr h = IntPtr.Zero;
        for (int i = 0; i < 5 && h == IntPtr.Zero; i++)
        {
            if (i > 0) Thread.Sleep(200);
            h = ByTitle(fragment);
        }
        if (h == IntPtr.Zero) { Console.WriteLine("NOWINDOW"); return 1; }

        string title = TitleOf(h);
        var steps = new StringBuilder();

        if (pause) { Tap(VK_MEDIA_PLAY_PAUSE); steps.Append("paused "); }

        // Raise it. SwitchToThisWindow rather than tapping ALT: a lone ALT is
        // read by browsers as "focus the menu", which left a focus ring on a
        // random nav link after every summon.
        bool raised = Raise(h);
        if (!raised) steps.Append("raise-failed ");
        // Restore ONLY if minimised. SW_RESTORE on a maximised or fullscreen
        // window un-maximises it, so calling it unconditionally meant every
        // summon started by fighting the state it was about to ask for.
        if (IsIconic(h)) { ShowWindow(h, SW_RESTORE); Thread.Sleep(120); steps.Append("unmin "); raised = Raise(h); }

        RECT r;
        GetWindowRect(h, out r);
        bool onScreen = r.Left >= sx - 8 && r.Left < sx + sw;

        if (!onScreen)
        {
            bool wasFull = (r.Right - r.Left) >= sw - 4 && (r.Bottom - r.Top) >= sh - 4;
            // Neither a fullscreen nor a maximised window can be moved: the
            // call is ignored silently. Both states have to be left first.
            if (wasFull) { Tap(VK_F11); Thread.Sleep(260); steps.Append("unfull "); }
            if (IsZoomed(h)) { ShowWindow(h, SW_RESTORE); Thread.Sleep(160); steps.Append("unmax "); }

            int w = Math.Min(1200, sw - 120);
            int t = Math.Min(760, sh - 120);
            bool moved = MoveWindow(h, sx + 60, sy + 60, w, t, true);
            steps.Append("move=" + moved + " ");
            Thread.Sleep(160);
            raised = Raise(h);
            GetWindowRect(h, out r);
        }

        bool full = (r.Right - r.Left) >= sw - 4 && (r.Bottom - r.Top) >= sh - 4;
        if (!full && raised)
        {
            /*
              F11, then check whether it actually did anything.

              F11 is a BROWSER CHROME shortcut, and an installed web app has no
              browser chrome — so on a PWA window it frequently does nothing at
              all. Measured: three summons in a row each reported "sent-f11"
              and each found the window still 1200x760, because the key was
              landing on a window with no handler for it. Reporting the key as
              sent is not the same as the window being fullscreen, and only one
              of those is what was asked for.

              Maximise is the fallback rather than the default because a
              maximised browser TAB still shows its tab strip, which is not
              what "fullscreen" means there. On a PWA there is no chrome to
              hide, so maximised and fullscreen look identical — which is
              exactly the case this fallback exists for.
            */
            Tap(VK_F11);
            steps.Append("f11 ");
            Thread.Sleep(300);
            GetWindowRect(h, out r);
            bool nowFull = (r.Right - r.Left) >= sw - 4 && (r.Bottom - r.Top) >= sh - 4;
            if (!nowFull)
            {
                ShowWindow(h, SW_MAXIMIZE);
                Thread.Sleep(160);
                GetWindowRect(h, out r);
                steps.Append("maximised ");
            }
        }
        else if (!full) steps.Append("f11-skipped-not-foreground ");

        Console.WriteLine(
            title + "|" + (full ? "already-fullscreen" : "sent-f11") +
            "|" + (onScreen ? "in-place" : "moved") +
            "|" + steps.ToString().Trim() +
            "|rect=" + r.Left + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top));
        return 0;
    }
}
