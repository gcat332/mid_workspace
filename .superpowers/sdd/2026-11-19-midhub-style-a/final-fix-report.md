# Style-A final fix report
1. StatusPill failed: removed dark:bg-red-950/dark:text-red-300 and dark dot red-400.
2. AuditLog: table min-w-[56rem], Details td min-w-64, Action td min-w-32; test added in AdminStyle.test.tsx.
3. Running/busy dot: dark:bg-blue-300.
4. MidPanel: per-button aria-describedby (mid-restart-reason / mid-busy-reason / mid-start-reason); mid-btn-reasons removed; tests updated + new per-button test.
5. OverviewTab grid: grid-cols-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4.
6. Stopped dot: bg-gray-500.
7. editor-language dot-file branch returns "plaintext"; MidActionsMenu trigger aria-controls -> menu id when open.

Commands: npx vitest run -> 98 files, 1172 tests passed; npx tsc --noEmit -> clean; npx eslint on changed files -> clean.
