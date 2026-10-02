# Security

## Reporting a problem

Please report a security problem privately, not in a public issue: open the repository's **Security** tab
and choose **Report a vulnerability**. That sends it to the maintainer only.

Include what you did, what happened, and the version of MushrifLoop and of Claude Code. You will get an
answer there. This is a one-person project, so allow a few days.

## What is in scope

MushrifLoop starts `claude` processes in a project folder you choose, with the permission mode you set. A
report is in scope when the app itself does something it should not, for example:

- it starts a process, or opens a file or a link, that the task and your settings do not call for;
- it passes an API key or another secret to a process when the setting that allows it is off;
- the renderer reaches the file system or a process other than through the app's typed bridge;
- it writes outside its data folder (`%APPDATA%\MushrifLoop`), the project folder, or the folder you set.

What Claude Code does inside a turn you approved, and the model's own behaviour, belong to Anthropic's
products; report those to Anthropic.

## Supported versions

Only the latest release gets fixes.
