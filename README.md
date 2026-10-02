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

## What it is not

It is not a way to make Claude Code cheaper or to get more out of a subscription. Two supervised sessions
generally use more tokens and take longer than one plain session on the same work, more so on large tasks.
What you get in return is the supervision: an instruction you can read and approve before it reaches the
Executor, a reviewer with no write access, a full record of every turn, and a task that stops and asks
rather than guessing.

A benchmark against plain Claude Code sessions is under way. Its numbers will be published here when it is
finished, whatever they say.

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
