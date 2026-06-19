## [0.9.2] — 2026-06-19

### Fixed

- **Atomics.wait() CPU spin** — `sleepSync()` in daemon-children now catches the exception thrown in Spectre-mitigated environments and falls back to a bounded busy-wait instead of spinning at 100% CPU
- **Windows file lock stolen from live holder** — The daemon-children registry lock now writes the holder PID into the lock directory; potential thieves verify the holder is dead before stealing, preventing a live holder from losing its lock after a GC pause
- **PR cache not reset on batch failure** — `prListUnchangedRepos` markers are now committed only after a successful SCM batch fetch; a failing batch no longer causes `detectPR` to silently skip repos, preventing missed PRs during failure windows
- **isProcessAlive() EPERM false positive** — Introduced `isDaemonAlive()` which treats EPERM as dead for running.json daemon PID checks (EPERM means OS PID reuse by a different-user process after a crash); `isProcessAlive()` retains EPERM=alive semantics for file lock holder checks
- **agentmesh-core SQLite crash on Windows** — `CoordinationService.cleanup()` now closes `lockManager` and `costTracker` in addition to `taskManager`; previously, unclosed `better-sqlite3` handles caused an ACCESS_VIOLATION (exit code 3221225477) during process exit
- **DirectoryBrowser keyboard navigation test** — ArrowDown test now fires `keyDown` on the browser container element (an ancestor of `contentRef`) rather than on a row button, matching the actual keyboard navigation UX pattern
