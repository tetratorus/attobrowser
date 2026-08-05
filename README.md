# attobrowser

Raw Chrome DevTools Protocol access to your real, logged-in browser. 85 lines, zero dependencies.

Built on a bet: models are smart. They know CDP, they can read [the protocol docs](https://chromedevtools.github.io/devtools-protocol/), and they don't need `click()` wrappers, element registries, or a bundled automation framework deciding what they're allowed to observe. Give them the pipe.

```
┌─────────┐  bash   ┌────────┐  long-poll  ┌───────────┐  chrome.debugger  ┌──────┐
│  agent  │ ──────► │ bridge │ ◄────────── │ extension │ ────────────────► │ tabs │
└─────────┘  atto   └────────┘   localhost └───────────┘        CDP        └──────┘
```

## Setup

1. `./atto serve` — start the bridge (localhost:9333)
2. chrome://extensions → Developer mode → Load unpacked → `ext/`
3. `./atto tabs.list` — if JSON comes back, you're live

## Usage

Any CDP method, verbatim:

```sh
atto tabs.new '{"url":"https://example.com"}'        # returns tab, note the id
atto Page.navigate '{"url":"https://example.com"}' <tabId>
atto Runtime.evaluate '{"expression":"document.title","returnByValue":true}' <tabId>
atto Page.captureScreenshot '{}' <tabId>             # big base64 auto-saved, path printed
atto q 'sign ?in' <tabId>                            # grep visible interactive elements
```

Only three verbs aren't raw CDP:

- `tabs.list` / `tabs.new` — tab handles live outside CDP's reach from an extension
- `q ['regex']` — dumps visible interactive elements as `x,y <tag> text` lines, filtered page-side by your regex. Empty pattern dumps all (~2KB for a dense page vs ~50KB of accessibility tree). This replaces both "read page" and "find element": you write the regex, you get coordinates, you click them.

Mouse events get a phantom cursor for free — a fixed-position SVG that glides to (x,y) before the real input lands, self-installs on any page, and auto-hides during screenshots so the model never sees its own pointer. It's cosmetic; the input is real CDP.

## Recipes

No API for these — they're just CDP. Paste-adapt as needed.

**Click** (coordinates from `q`):

```sh
atto Input.dispatchMouseEvent '{"type":"mouseMoved","x":128,"y":396}' $TAB
atto Input.dispatchMouseEvent '{"type":"mousePressed","x":128,"y":396,"button":"left","clickCount":1}' $TAB
atto Input.dispatchMouseEvent '{"type":"mouseReleased","x":128,"y":396,"button":"left","clickCount":1}' $TAB
```

**Type** — into the focused element (click it first):

```sh
atto Input.insertText '{"text":"hello world"}' $TAB
```

Real keystrokes (for pages with key handlers): `Input.dispatchKeyEvent` with `keyDown`/`keyUp`, or press Enter:

```sh
atto Input.dispatchKeyEvent '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"text":"\r"}' $TAB
atto Input.dispatchKeyEvent '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}' $TAB
```

**Scroll**:

```sh
atto Input.dispatchMouseEvent '{"type":"mouseWheel","x":400,"y":400,"deltaY":600}' $TAB
```

**Page text** (the reading-an-article case):

```sh
atto Runtime.evaluate '{"expression":"document.body.innerText.slice(0,5000)","returnByValue":true}' $TAB
```

**Wait** — don't sleep and hope; poll the condition. Soft navigations (GitHub, SPAs) commit the URL late:

```sh
atto Runtime.evaluate '{"expression":"location.href+\" \"+document.readyState","returnByValue":true}' $TAB
```

**Debug a click that "didn't work"** — instrument the page, dispatch, read back:

```sh
atto Runtime.evaluate '{"expression":"window.__ev=[];[\"pointerdown\",\"click\"].forEach(t=>addEventListener(t,e=>__ev.push(t+\"@\"+e.clientX+\",\"+e.clientY+\" on \"+e.target.tagName),{capture:true}));0","returnByValue":true}' $TAB
# ...dispatch the click, then:
atto Runtime.evaluate '{"expression":"window.__ev.join(\"; \")","returnByValue":true}' $TAB
```

**Everything else**: cookies (`Network.getCookies`), request interception (`Fetch.enable`), device emulation (`Emulation.*`), init scripts (`Page.addScriptToEvaluateOnNewDocument`), PDF export (`Page.printToPDF`) — it's all just there. If CDP can do it, atto can do it, because atto *is* CDP.

Gotchas: `Runtime.evaluate` shares the page's global scope across calls — wrap in an IIFE or you'll hit `Identifier 'x' has already been declared`. Coordinates from `q` go stale after navigation — re-run `q`. The "attobrowser started debugging this browser" infobar is Chrome's `chrome.debugger` notice; Cancel detaches, the next command re-attaches.

## Non-goals

Element ref registries (state that goes stale), semantic element search (the calling model is the semantic engine — regex + retry is free), retry/wait logic (the model retries better than code: it re-reads the page first), per-action wrappers (`click()`, `type()` — condescension as API design).

Prior art, for contrast: [nanobrowser](https://github.com/nanobrowser/nanobrowser) bundles puppeteer-core, a three-agent framework, and a 1,500-line DOM annotator into the same `chrome.debugger` foundation. Claude in Chrome curates ~30 tools over it, with an LLM subcall inside its `find`. attobrowser is the third point in that design space: the pipe, a cursor, and grep.
