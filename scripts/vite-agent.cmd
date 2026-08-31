@echo off
REM Vite on the agent worktree - the :9443 build, branch "agent".
REM
REM Same reasoning as vite-main.cmd: this used to live in a Claude session's
REM scratchpad, which is temporary and conversation-scoped.
REM
REM Note the working directory is the WORKTREE, not this repo. That is the
REM point of :9443 - it serves what the in-app agent is writing, which is a
REM different checkout to the one the live app is built from.
cd /d D:\Projects\Operator-agent
echo ==== vite agent started %DATE% %TIME% ==== >> "D:\Projects\operator\data\vite-agent.log"
npx vite --port 5175 --host >> "D:\Projects\operator\data\vite-agent.log" 2>&1
