// attobrowser: long-polls the local bridge, pipes commands into chrome.debugger.
const BRIDGE = "http://localhost:9333";
const attached = new Set();
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
setInterval(chrome.runtime.getPlatformInfo, 20e3); // keep MV3 service worker alive

async function handle({ id, method, params = {}, tabId }) {
  try {
    if (method === "tabs.list") return { id, result: await chrome.tabs.query({}) };
    if (method === "tabs.new") return { id, result: await chrome.tabs.create({ url: params.url }) };
    tabId ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (!attached.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached.add(tabId);
    }
    return { id, result: await chrome.debugger.sendCommand({ tabId }, method, params) };
  } catch (e) {
    return { id, error: String(e.message ?? e) };
  }
}

(async () => {
  while (true) {
    try {
      const r = await fetch(BRIDGE + "/poll");
      if (r.status !== 200) continue; // 204 = no work, poll again
      handle(await r.json()).then((out) =>
        fetch(BRIDGE + "/result", { method: "POST", body: JSON.stringify(out) })
      );
    } catch {
      await new Promise((r) => setTimeout(r, 1000)); // bridge down, chill
    }
  }
})();
