# MushrifLoop

**[Website](https://hqudsi.github.io/mushrifloop/)** · **[Download](../../releases/latest)** · [العربية](https://hqudsi.github.io/mushrifloop/ar/)

*Mushrif* (مشرف) is Arabic for "supervisor". MushrifLoop is a supervised two-agent orchestrator for
[Claude Code](https://claude.com/claude-code): a Windows desktop app that runs a coding task as a loop
between two Claude Code sessions on your own computer:

- a **Planner** reads the task, decides the next single step, and reviews each result. It never touches
  your files.
- an **Executor** carries out that one step in your project folder and reports what it changed and what it
  ran.

The app is the orchestrator between them. It passes each instruction and each report across, and it holds the limits and
checkpoints: approvals, cycle caps, timeouts, loop detection, a commit per cycle on a branch of its own,
account checks, and usage-limit handling. It stops and asks you whenever a decision is yours.

MushrifLoop is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by
Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## What you need

- Windows 10 or 11, x64.
- **Claude Code installed and signed in on the machine**, version 2.1.251 or newer.

MushrifLoop never talks to the Anthropic API itself. Every turn is an ordinary `claude` process started on
your machine, unmodified, under whoever is signed in to Claude Code. All the work runs on your own Claude
account and its limits; the app has no account, key or billing of its own. First-run setup checks that the
CLI is present, new enough and signed in before it lets you start.

## What you get

- **Supervision.** Every instruction can be read and approved before it reaches the Executor.
- **A review of every step.** A second session checks each result against the task before the next step
  starts.
- **Coordination.** The app moves the work between the two sessions, and handles context, limits and
  handoffs itself.
- **Follow-up.** A timeline of every cycle, a commit per cycle, and the full record of every turn.
- **Your time.** A long task runs unattended and calls you only when a decision is yours.

## What it costs

How much it uses depends on the size of the task, and on what you compare it with. In our first
measurements (22 tasks, one run each, with the Planner on Opus and the Executor on Sonnet):

- **Small and medium tasks** cost about a quarter less than a plain Opus session.
- **Large tasks** cost a little over twice as much as a plain Opus session.
- Against a plain Sonnet session it cost more at every size: about 1.4 times on small and medium tasks, and
  1.7 times on large ones.
- The Planner is the small part of the cost: about 6% on large tasks. The Executor's work is the rest.
- It takes longer than a plain session, nearly twice as long on large tasks. It does not need you while it
  runs.
- The three finished the medium and large tasks equally well.

These are early numbers. The full benchmark is under way and will be published here, whatever it says.

## Install

Download the installer (or the portable exe) from the [Releases](../../releases) page.

**The installer is not code-signed yet.** Windows SmartScreen will say "Windows protected your PC" and name
an unknown publisher. Choose **More info**, then **Run anyway**. Each release lists the SHA-256 of its
files, so you can check that what you downloaded is what was published:

```
certutil -hashfile MushrifLoop-<version>-x64-setup.exe SHA256
```

There is no auto-update. A new version is a new installer from the same page.

## Your data

- Tasks, settings and logs live in `%APPDATA%\MushrifLoop` on your machine. They stay there when you
  uninstall, unless you tick the box that says otherwise.
- The app collects nothing and has no telemetry. The only network request it makes itself is a check of the
  npm registry for the latest Claude Code version, to tell you when your CLI is out of date. Everything
  else on the network is Claude Code's own traffic.
- In a project it works on, the Executor may write long evidence to a `.mushrifloop/` folder. That folder is
  never committed.

## From source

```
npm install
npm start
```

- `npm test` runs the test suite.
- `npm run typecheck` checks the main process and the tests.
- `npm run pack` builds the Windows installer and a portable exe into `release/`.

The code is Electron + Angular + TypeScript. The main process (`src/main/`) spawns the CLI, runs the
orchestrator's state machine and stores every turn; the renderer (`src/renderer/`) reaches it only through
the typed bridge in `src/preload/`. The agents' prompts are in `agents/`, and the JSON schemas their answers
must match are in `schemas/`. Comments in the code cite `SPEC.md` and `NOTES.md`: these are the project's
design documents, which are not part of this repository yet.

## Questions, bugs, security

- Questions and bugs: open an issue in this repository.
- Security problems: see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The licenses of the open-source software
the app is built with are listed inside it, under Settings → About.

Copyright 2026 Hani Qudsi.
