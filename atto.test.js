const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { test } = require("node:test");
const { WebSocketServer } = require("ws");

const exec = promisify(execFile);
const cli = path.join(__dirname, "atto");

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "atto-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "caller");
  const other = path.join(root, "other");
  await fs.mkdir(cwd);
  await fs.mkdir(other);
  const calls = [];
  let targets = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/json/list");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(targets));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    ws.on("message", (data) => {
      const message = JSON.parse(data);
      calls.push({ target: req.url, ...message });
      if (message.method === "Test.disconnect") return ws.close();
      if (message.method === "Test.hang") return;
      ws.send(JSON.stringify({ id: message.id, result: { target: req.url } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const page = (id, url = "about:blank") => ({
    id, type: "page", title: id, url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}`,
  });
  targets = [page("first"), page("chosen"), { ...page("worker"), type: "service_worker" }];
  const run = async (args, dir = cwd, env = {}) => {
    try {
      const result = await exec(process.execPath, [cli, ...args], {
        cwd: dir, env: { ...process.env, ATTOBROWSER_PORT: String(port), ...env }, timeout: 5000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (error.killed) throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return { cwd, other, port, page, calls, run, setTargets: (value) => { targets = value; } };
}

test("tabs lists page targets without selecting one", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["tabs"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map((tab) => tab.id), ["first", "chosen"]);
  await assert.rejects(fs.access(path.join(f.cwd, "attobrowser-state.json")), { code: "ENOENT" });
});

test("raw commands require an explicit attachment", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["Runtime.evaluate", "{}"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /atto attach/);
  assert.equal(f.calls.length, 0);
});

test("attachment persists in caller cwd and pins commands despite tab order and environment changes", async (t) => {
  const f = await fixture(t);
  const attached = await f.run(["attach", "chosen"]);
  assert.equal(attached.code, 0, attached.stderr);
  const saved = JSON.parse(await fs.readFile(path.join(f.cwd, "attobrowser-state.json"), "utf8"));
  assert.deepEqual(saved, { port: f.port, targetId: "chosen" });
  f.setTargets([f.page("new-foreground"), f.page("chosen", "about:blank#navigated"), f.page("first")]);
  const result = await f.run(["Runtime.evaluate", '{"expression":"document.title"}'], f.cwd, { ATTOBROWSER_PORT: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).target, "/chosen");
  assert.equal(f.calls[0].params.expression, "document.title");
  const state = await f.run(["state"], f.cwd, { ATTOBROWSER_PORT: "1" });
  assert.deepEqual(JSON.parse(state.stdout), {
    stateFile: path.join(f.cwd, "attobrowser-state.json"), ...saved,
    status: "available", title: "chosen", url: "about:blank#navigated",
  });
});

test("different caller directories retain independent attachments", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "chosen"])).code, 0);
  assert.equal((await f.run(["attach", "first"], f.other)).code, 0);
  assert.equal(JSON.parse((await f.run(["Runtime.evaluate"])).stdout).target, "/chosen");
  assert.equal(JSON.parse((await f.run(["Runtime.evaluate"], f.other)).stdout).target, "/first");
});

test("missing targets never fall back or change saved selection", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "chosen"])).code, 0);
  f.setTargets([f.page("first")]);
  const result = await f.run(["Runtime.evaluate"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /chosen.*missing/);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse((await f.run(["state"])).stdout).status, "target missing");
  const failedAttach = await f.run(["attach", "unknown"]);
  assert.equal(failedAttach.code, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.cwd, "attobrowser-state.json"), "utf8")).targetId, "chosen");
});

test("attach rejects non-page targets and accepts an explicit port", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "worker"])).code, 1);
  const result = await f.run(["attach", "chosen", String(f.port)], f.cwd, { ATTOBROWSER_PORT: "1" });
  assert.equal(result.code, 0, result.stderr);
});

test("state distinguishes unattached and unreachable without changing state", async (t) => {
  const f = await fixture(t);
  const empty = await f.run(["state"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, "not attached");
  const unused = http.createServer();
  await new Promise((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const port = unused.address().port;
  await new Promise((resolve) => unused.close(resolve));
  const filename = path.join(f.cwd, "attobrowser-state.json");
  const saved = JSON.stringify({ port, targetId: "chosen" });
  await fs.writeFile(filename, saved);
  const result = await f.run(["state"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "browser unreachable");
  assert.equal(await fs.readFile(filename, "utf8"), saved);
  assert.equal((await f.run(["Runtime.evaluate"])).code, 1);
});

test("invalid state fails closed rather than selecting a default", async (t) => {
  const f = await fixture(t);
  for (const value of ["{", "null", '{"port":0,"targetId":"chosen"}', '{"port":9229}', '{"port":"9229","targetId":"chosen"}']) {
    await fs.writeFile(path.join(f.cwd, "attobrowser-state.json"), value);
    const result = await f.run(["Runtime.evaluate"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid state/);
  }
  assert.equal(f.calls.length, 0);
});

test("invalid attachment arguments do not create state", async (t) => {
  const f = await fixture(t);
  for (const args of [["attach"], ["attach", "chosen", "0"], ["attach", "chosen", "99999"], ["attach", "chosen", "123abc"]]) {
    assert.equal((await f.run(args)).code, 1);
  }
  await assert.rejects(fs.access(path.join(f.cwd, "attobrowser-state.json")), { code: "ENOENT" });
});

test("explicit reattachment switches tabs and discovery reuses the saved port", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "chosen"])).code, 0);
  const env = { ATTOBROWSER_PORT: undefined };
  assert.equal((await f.run(["tabs"], f.cwd, env)).code, 0);
  assert.equal((await f.run(["attach", "first"], f.cwd, env)).code, 0);
  assert.equal(JSON.parse((await f.run(["Runtime.evaluate"])).stdout).target, "/first");
  const nested = path.join(f.cwd, "nested");
  await fs.mkdir(nested);
  assert.equal(JSON.parse((await f.run(["state"], nested)).stdout).status, "not attached");
});

test("explicit attachment can repair malformed state", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, "attobrowser-state.json"), "{");
  const result = await f.run(["attach", "chosen", String(f.port)]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse((await f.run(["state"])).stdout).targetId, "chosen");
});

test("unanswered CDP commands time out without replay", async (t) => {
  const f = await fixture(t);
  const client = await require("./lib/cdp").connect(f.page("chosen").webSocketDebuggerUrl, 100);
  t.after(() => client.close());
  await assert.rejects(client.send("Test.hang"), /timed out; outcome unknown/);
  assert.equal(f.calls.length, 1);
});

test("session processes raw commands on one pinned connection and closes on EOF", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "chosen"])).code, 0);
  const session = exec(process.execPath, [cli, "session"], { cwd: f.cwd, timeout: 5000 });
  session.child.stdin.end([
    JSON.stringify({ method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } }),
    "invalid json",
    JSON.stringify({ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 100, y: 100, deltaY: 100, deltaX: 0 } }),
    JSON.stringify({ method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } }),
    "",
  ].join("\n"));
  const { stdout } = await session;
  const output = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(output[0].status, "connected");
  assert.equal(output[0].targetId, "chosen");
  assert.deepEqual(output[1], { result: { target: "/chosen" } });
  assert.equal(typeof output[2].error, "string");
  assert.deepEqual(output[3], { result: { target: "/chosen" } });
  assert.deepEqual(output[4], { result: { target: "/chosen" } });
  assert.deepEqual(f.calls.map((call) => call.id), [1, 2, 3]);
});

test("a tab closing during a command fails promptly without replaying it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["attach", "chosen"])).code, 0);
  const result = await f.run(["Test.disconnect"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /closed/);
  assert.equal(f.calls.length, 1);
});
