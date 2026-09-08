# attobrowser

Raw Chrome DevTools Protocol access over WebSocket, with a persistent tab selection per working directory. No browser automation framework or element registry: actions are raw CDP methods.

## Setup

Requires Node.js and `npm install` in this repository. Chrome launch/stop is supported on macOS; connecting to an existing local CDP endpoint uses HTTP and WebSocket.

Run the `atto` executable by absolute path from the directory doing the browsing. The examples below use `atto` as shorthand; the repository does not install a global command.

```sh
atto state
atto tabs
atto attach TARGET_ID
atto Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
```

If Chrome is not already reachable with CDP, `atto start` launches it on port 9229 by default. **Starting can terminate an existing Chrome process and relaunch it; do not do this while others are using it without permission.** Raw commands do not automatically start Chrome.

The default launch profile is `~/.attobrowser-chrome`, not the normal Chrome profile. The launcher reads repository `config.json` or `~/.attobrowser/config.json`; its `chrome.userDataDir` setting can override the profile. See `lib/launch-chrome.js` for launcher configuration.

## Commands

| Command | Behavior |
| --- | --- |
| `atto tabs [port]` | List page target IDs, titles, and URLs; does not select a tab. |
| `atto attach <targetId> [port]` | Validate the tab connection and save its port and exact target ID. |
| `atto state` | Show saved selection and live availability, title, and URL. |
| `atto <Domain.method> [params-json]` | Send one raw CDP command to the saved target. |
| `atto start [port] [--kill]` | Start or reuse Chrome with CDP; does not select a tab. |
| `atto stop` | Terminate Chrome, not merely detach the client. |

For `tabs` and `attach`, port precedence is explicit argument, `ATTOBROWSER_PORT`, saved port, then 9229. For a custom-port launch, pass the port to the initial `tabs` and `attach` commands. `state` and raw CDP commands always use the saved port, even if the environment changes.

## Directory-scoped state

`atto attach` atomically writes `attobrowser-state.json` in the **caller's current working directory**, not in the executable's directory:

```json
{
  "port": 9229,
  "targetId": "ABC123"
}
```

Run all commands for a task from the same directory. There is no parent-directory search. Different directories have independent selections; two agents in the same directory share the selection. Keep the state file out of version control; this repository ignores it, but other caller repositories need their own ignore rule.

Foreground focus, tab ordering, and navigation do not change the selection. `atto attach <otherTargetId>` is the explicit way to switch. New tabs and popups are not selected automatically. Commands never fall back to the first tab or a URL match.

`atto state` prints JSON with `stateFile`, the saved `port` and `targetId` when present, and one of these statuses:

- `not attached`: no state file exists.
- `available`: Chrome lists the selected page target; live `title` and `url` are included. This does not mean a CDP socket is held open or the page has finished loading.
- `target missing`: Chrome is reachable, but the selected tab no longer exists.
- `browser unreachable`: the saved CDP port cannot be queried.

State inspection does not modify the selection. Missing targets and unreachable browsers cause raw commands to fail. Malformed state also fails closed; an explicit `atto attach <targetId> <port>` can replace it after validating the intended tab. A browser restart can invalidate saved IDs.

The state file persists **tab identity**, not a live CDP session. One-shot invocations open and close their own sockets; session-scoped settings do not persist between them. Browser/page state itself remains in Chrome.

## Persistent sessions

`atto session` opens one connection to the saved target and accepts newline-delimited JSON on stdin:

```json
{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}
{"method":"Page.captureScreenshot"}
```

The first output line reports `status: "connected"`, the state-file path, port, and target ID. Each command produces one JSON line containing `result` or `error`, in order. Screenshot output remains a file path. Invalid commands are reported without ending the session. EOF disconnects without stopping Chrome. There are no automatic retries or reconnects, and CDP events are not output.

The session stays pinned to its original target, even if another process changes the state file. End it before deliberately attaching to a different tab. `atto state` still reports the saved directory selection, not a registry of live connections.

For background input that stalls (observed with wheel events in Chrome), use the same session to send `Emulation.setFocusEmulationEnabled` with `{"enabled":true}`, move the pointer to freshly observed coordinates, send input, capture a screenshot, and verify the actual UI change/scroll offset. Then send the emulation command with `{"enabled":false}`. Focus emulation temporarily changes page focus/visibility APIs without selecting the foreground tab. Keep it enabled until the expected change is observed; separate one-shot calls lose this setting when their sockets close.

## Interactive workflow

Observe, act, wait for a relevant condition, then observe again. When asked to inspect the current page, do not navigate or reload it first.

```sh
atto Runtime.evaluate '{"expression":"({url:location.href,title:document.title,readyState:document.readyState})","returnByValue":true}'
atto Runtime.evaluate '{"expression":"document.body?.innerText.slice(0,5000)","returnByValue":true}'
atto Page.captureScreenshot
```

Large base64 result fields are saved to temporary files and their paths printed instead. Read screenshot files to inspect the page visually.

Navigation uses `Page.navigate`; typing uses `Input.insertText`; clicking, keys, and scrolling use raw `Input` events. Verify the intended destination and a page-specific condition after navigation: the navigation response is not proof of readiness, and `document.readyState` alone can describe the old document or miss SPA updates.

Refresh observations and coordinates after navigation, scrolling, or layout changes. Discard document-bound handles after navigation. Wrap evaluated code in an IIFE to avoid conflicting global bindings. Other users can operate different tabs without redirecting commands, but changes to the same tab are not isolated.

Background tabs can have populated DOM nodes but empty `innerText` because rendering is skipped (`content-visibility: auto`, observed in Drive). Capture a screenshot of the pinned tab, then re-read the text; this refreshed the visible rows without bringing Drive to the foreground. Scoped `textContent` or accessibility labels can help inspect the DOM, but may include hidden controls. Check the intended URL and actual content, not only `readyState`, row count, or default `checkVisibility()`. Do not steal foreground focus or repeat a navigation just because the first observation is incomplete.

Timeouts and disconnections do not trigger retries or tab reselection. A command may have taken effect before the connection failed; inspect before retrying a click or submission. Do not use `atto stop` as routine cleanup: commands already close their own connections and leave Chrome running.

## Verification

Run `npm test`. Tests use Node's built-in test runner and a local mock CDP server with temporary caller directories; they do not launch or touch Chrome.

`node --test patch.test.js` checks the separate `cdpkit-chrome-driver.patch`
artifact using isolated DOM/transport fixtures. It does not apply that patch or
launch Chrome; the patch remains separate from the raw-CDP implementation here.
