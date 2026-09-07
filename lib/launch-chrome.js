const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const DEFAULT_PORT = 9229;
const DEFAULT_PROFILE = path.join(HOME, ".attobrowser-chrome");
const REPO_CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
const HOME_CONFIG_PATH = path.join(HOME, ".attobrowser", "config.json");

function expandHome(p) {
  if (typeof p !== "string") return p;
  return p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
}

function loadConfig() {
  const defaults = {
    chrome: {
      bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      port: DEFAULT_PORT,
      kill: false,
      userDataDir: DEFAULT_PROFILE,
    },
    timeouts: {
      waitForCdpAttempts: 40,
      waitForCdpIntervalMs: 1000,
      killTimeoutMs: 10000,
    },
  };

  let fileConfig = {};
  for (const p of [REPO_CONFIG_PATH, HOME_CONFIG_PATH]) {
    try {
      if (fs.existsSync(p)) {
        fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
        break;
      }
    } catch {}
  }

  function merge(base, over) {
    const out = { ...base };
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k])) {
        out[k] = merge(base[k] || {}, over[k]);
      } else {
        out[k] = over[k];
      }
    }
    return out;
  }

  const cfg = merge(defaults, fileConfig);

  if (process.env.ATTOBROWSER_CHROME_BIN) cfg.chrome.bin = process.env.ATTOBROWSER_CHROME_BIN;
  if (process.env.ATTOBROWSER_PORT) cfg.chrome.port = parseInt(process.env.ATTOBROWSER_PORT, 10);
  if (process.env.ATTOBROWSER_KILL) cfg.chrome.kill = process.env.ATTOBROWSER_KILL === "true";
  if (process.env.ATTOBROWSER_WAIT_ATTEMPTS) cfg.timeouts.waitForCdpAttempts = parseInt(process.env.ATTOBROWSER_WAIT_ATTEMPTS, 10);

  cfg.chrome.bin = expandHome(cfg.chrome.bin);
  cfg.chrome.userDataDir = expandHome(cfg.chrome.userDataDir);
  return cfg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listTargets(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}/json/list`,
      { timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", reject);
  });
}

async function reachable(port) {
  try {
    await listTargets(port, 2000);
    return true;
  } catch {
    return false;
  }
}

function isRunning() {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", "Google Chrome"], (err) => resolve(!err));
  });
}

async function waitUntilDead(timeoutMs = 10000) {
  const start = Date.now();
  while (await isRunning()) {
    if (Date.now() - start > timeoutMs) break;
    await sleep(200);
  }
}

function killChrome(wait = true, timeoutMs = 10000) {
  const killCmd =
    'killall -TERM "Google Chrome" 2>/dev/null; killall -TERM "Google Chrome Helper" 2>/dev/null; sleep 1; killall -9 "Google Chrome" 2>/dev/null; killall -9 "Google Chrome Helper" 2>/dev/null';
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", killCmd], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", resolve);
  }).then(async () => {
    if (wait) await waitUntilDead(timeoutMs);
  });
}

function chromeArgs(cfg, port) {
  return [
    cfg.chrome.bin,
    `--user-data-dir=${cfg.chrome.userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

function launchChrome(cfg, port) {
  const args = chromeArgs(cfg, port);
  const child = spawn(args[0], args.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function waitForChild(child) {
  return new Promise((_, reject) => {
    child.once("error", (err) => reject(new Error(`Chrome failed to start: ${err.message}`)));
    child.once("exit", (code, signal) => {
      reject(new Error(`Chrome exited before CDP was ready (code=${code}, signal=${signal})`));
    });
  });
}

async function waitForCdp(port, cfg) {
  const attempts = cfg.timeouts.waitForCdpAttempts;
  const interval = cfg.timeouts.waitForCdpIntervalMs;
  for (let i = 0; i < attempts; i++) {
    if (await reachable(port)) return;
    await sleep(interval);
  }
  throw new Error(`Chrome CDP did not become reachable on port ${port}`);
}

async function start({ port, kill } = {}) {
  const cfg = loadConfig();
  const targetPort = port ?? cfg.chrome.port;
  const shouldKill = kill ?? cfg.chrome.kill;

  if (process.platform !== "darwin") {
    throw new Error("Chrome launch is only supported on macOS");
  }
  if (!fs.existsSync(cfg.chrome.bin)) {
    throw new Error(`Chrome binary not found: ${cfg.chrome.bin}`);
  }

  const alreadyCdp = await reachable(targetPort);
  if (alreadyCdp && !shouldKill) {
    console.log(`Chrome already reachable on port ${targetPort}`);
    return { port: targetPort, started: false };
  }

  const running = await isRunning();
  if (alreadyCdp || running || shouldKill) {
    await killChrome(true, cfg.timeouts.killTimeoutMs);
    await sleep(1000);
  }

  const child = launchChrome(cfg, targetPort);
  await Promise.race([waitForCdp(targetPort, cfg), waitForChild(child)]);
  console.log(`Chrome started with CDP on port ${targetPort}`);
  return { port: targetPort, started: true, pid: child.pid };
}

async function stop() {
  if (process.platform !== "darwin") {
    throw new Error("Chrome stop is only supported on macOS");
  }
  const cfg = loadConfig();
  await killChrome(true, cfg.timeouts.killTimeoutMs);
  console.log("Chrome stopped");
}

module.exports = { start, stop, reachable, DEFAULT_PORT, listTargets };
