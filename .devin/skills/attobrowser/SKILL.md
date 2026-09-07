---
name: attobrowser
description: Drive Chrome via raw CDP with a persistent, directory-scoped tab selection
argument-hint: "<task or command>"
allowed-tools:
  - exec
  - read
triggers:
  - user
  - model
---

# attobrowser skill

## Working directory and executable

Keep the caller's working directory for every browser command. Do not change to
the attobrowser repo: the selected tab is stored in `attobrowser-state.json` in
the command's working directory. Remember this directory and explicitly use it
as the exec working directory across follow-up turns.

Resolve the repository root from this skill's source path: it is three directories
above the directory containing this `SKILL.md`. Invoke its `atto` executable by
absolute path. The commands below use `atto` as shorthand for that executable,
not a shell alias or a command supplied by this skill.

If dependencies are missing, run `npm --prefix <absolute-repository-root> install`
without changing the browser-command working directory.

## Select once, then stay on that tab

1. Run `atto state` to inspect the saved selection and its live availability.
2. If available, reuse that tab for a continuation of the task. Observe its
   current content before acting; the user may have changed it since last time.
3. If no tab is attached, run `atto tabs`, identify the intended tab by its
   title/URL, then run `atto attach <targetId>`. If the intended tab is ambiguous,
   ask rather than guessing. Never equate the first listed tab with the foreground tab.
4. Send raw CDP commands. Each invocation uses the saved port and exact target ID,
   regardless of foreground focus, tab ordering, or `ATTOBROWSER_PORT` changes.
5. To switch tabs deliberately, run `atto attach <otherTargetId>`. Navigation
   within the selected tab does not require reattachment. A popup or new tab does
   not automatically become the selected tab.

Example sequence, with the same caller working directory on every invocation:

```bash
atto state
atto tabs
atto attach <targetId>
atto Runtime.evaluate '{"expression":"({url:location.href,title:document.title,readyState:document.readyState,text:document.body?.innerText.slice(0,5000)})","returnByValue":true}'
atto Page.captureScreenshot
```

Use the read tool to inspect screenshot files returned by the CLI. Keep commands
raw CDP; do not introduce an element registry or assume old coordinates still work.

## State and commands

- `atto tabs [port]` — list page target IDs, titles, and URLs without selecting one.
- `atto attach <targetId> [port]` — validate a page target's connection and atomically
  save `{ "port": 9229, "targetId": "..." }` in the caller's state file.
- `atto state` — print the absolute state-file path, saved selection, and status:
  `not attached`, `available`, `target missing`, or `browser unreachable`. Title
  and URL are fetched live when available; they are not stored as tab identity.
- `atto <Domain.method> [params-json]` — send raw CDP to the saved tab. Requires
  attachment; never falls back to the first page.
- `atto start [port] [--kill]` — start or reuse Chrome with CDP. Does not select a tab.
- `atto stop` — terminate Chrome, not merely detach from a tab. Only run when the
  user explicitly asks to stop Chrome.

For `tabs` and `attach`, port precedence is explicit argument, `ATTOBROWSER_PORT`,
saved port, then 9229. `state` and raw commands always use the saved port.
For a custom-port launch, pass that port to the initial `tabs` and `attach` calls.

State is scoped to the exact working directory, with no parent-directory lookup.
Different directories have independent selections. Agents sharing a directory
share the selection; this is not a per-agent lock. Keep the state file out of git.
It stores no page content, credentials, or live WebSocket connection.

## Interactive navigation

Observe → act → wait for a relevant condition → observe again.

- Inspect the attached tab without navigating when asked to look at the current page.
- After requested navigation, verify the destination URL and a task-relevant page
  condition. A successful `Page.navigate` response does not mean the page is ready;
  `document.readyState` alone may still describe the old page or miss SPA updates.
- After clicking or typing, inspect the result before the next dependent action.
  Refresh coordinates after scrolling/layout changes and discard document-bound
  handles after navigation. Wrap evaluated code in an IIFE to avoid global bindings.
- Humans and other agents can use other tabs without redirecting these commands.
  Changes to the same tab are not isolated: always use fresh observations.
- Only submit, send, purchase, delete, or otherwise mutate application data when
  authorized by the user's request.

### Background-tab observations

Do not bring the tab to the foreground just to read or click it. Inspect
`document.visibilityState` when diagnosing missing content, but never use focus
or visibility to choose the target.

Background rendering can lag behind navigation. In Drive, a completed document
and existing rows did not guarantee readable file names: rows using
`content-visibility: auto` returned empty `innerText` despite populated
`textContent`. Do not report an empty folder or retry the navigation on that basis.

- Check the expected URL and populated content, not just `readyState`, row count,
  or default `checkVisibility()`. Use a bounded wait; a click's effect can arrive
  after its CDP response, so observe again before repeating it.
- If text is unexpectedly empty, capture and read a screenshot of the pinned tab,
  then re-read `innerText`. This refreshed Drive's rendering while it stayed hidden.
- For DOM inspection, use scoped `textContent` or accessibility labels as a fallback,
  not an indiscriminate whole-document dump. They can include hidden controls and
  are not proof that an element is on screen. `checkVisibility({contentVisibilityAuto:true})`
  detects skipped rendering; recheck viewport bounds before coordinate input.

## Persistent input sessions

For multi-step input, run `atto session` with exec `tty: true` from the same caller
directory. Save the returned shell ID and use `write_to_process` to send one JSON
command per line; use `get_output` to inspect responses. The initial line reports
`connected` and the pinned target. Responses are `{ "result": ... }` or
`{ "error": "..." }`, in command order. Screenshot data is still saved to files.
The connection stays on that target even if another process changes the state file.
End the session before deliberately attaching a different tab.

```json
{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}
```

A background wheel event timed out in live Chrome. Enabling focus emulation on
one connection, then sending input and observing on that same connection, worked:

```json
{"method":"Emulation.setFocusEmulationEnabled","params":{"enabled":true}}
```

This emulates page focus, not foreground-tab selection. It temporarily changes
what the page sees from focus/visibility APIs. Use it only for the interaction.
Move the pointer to freshly observed coordinates, dispatch the wheel/input,
capture a screenshot to refresh rendering, then verify the actual scroll offset
or intended UI change. A successful input response alone is not sufficient.
Do not disable emulation until the expected change is observed.

```json
{"method":"Emulation.setFocusEmulationEnabled","params":{"enabled":false}}
```

Disable emulation afterward, including when abandoning an interaction. EOF
(Ctrl-D on an empty line) disconnects without closing Chrome or clearing the saved
tab. Separate one-shot calls cannot preserve this emulation setting. Sessions
retain CDP settings but currently output command responses only, not CDP events.

## Recovery and lifecycle

A missing target never causes automatic reselection. Inspect `atto state` and
`atto tabs`, report the lost tab, and select a replacement deliberately. A browser
restart can invalidate saved IDs. Do not use a URL match as an automatic fallback.
If a command times out or disconnects, its outcome may be unknown: inspect before
retrying, especially for clicks or submissions. Never blindly replay actions.
Malformed state fails closed; an explicit `atto attach <targetId> <port>` can
replace it after validating the intended target.

Raw commands do not auto-start Chrome. Try attachment/discovery first. If Chrome
is unreachable, explain before starting: the launcher can kill an existing Chrome
process and relaunch it. Do not restart a browser others are using without permission.
The default profile is `~/.attobrowser-chrome`, not the normal Chrome profile;
launcher configuration can override it.

One-shot commands close their CDP connection; `atto session` holds it until EOF.
Both leave Chrome and the saved selection alone. Do not call `stop` as routine
cleanup. `atto state` reports the directory's saved selection and availability,
not a registry of running sessions. Continuous CDP event output is not supported.

## Source of truth

Paths below are relative to the repository root resolved above:

- CLI: `atto`
- State: `lib/state.js`
- Transport: `lib/cdp.js`
- Launcher: `lib/launch-chrome.js`
