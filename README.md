# Operator — Personal OS (v1)

Dashboard-only build. Everything else in the sidebar is a placeholder waiting on approval for the next phase.

## Run it

```bash
npm install
npm run dev
```

Then open the printed localhost URL. Everything is stored in your browser's `localStorage` under `os.*` keys — nothing leaves your machine.

## What's here

- Architecture: `src/lib` (types + storage), `src/hooks` (localStorage + dashboard data), `src/context` (theme)
- Shell: `src/layouts/AppLayout.tsx`, `src/components/layout/*`, `src/components/command/CommandPalette.tsx` (Ctrl/Cmd+K)
- Dashboard: `src/pages/Dashboard.tsx` + `src/components/dashboard/*`

## Verified

- `npx tsc -b` — clean
- `npx vite build` — clean production build
