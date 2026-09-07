const WebSocket = require("ws");

function connect(wsUrl, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
    const pending = new Map();
    let nextId = 1;

    function fail(error) {
      reject(error);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
    }

    ws.once("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) return rej(new Error("CDP connection closed"));
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP command ${method} timed out; outcome unknown, inspect before retrying`));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }), (error) => {
              if (error) fail(error);
            });
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf);
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });

    ws.on("error", fail);
    ws.once("close", () => fail(new Error("CDP connection closed; outcome unknown, inspect before retrying")));
  });
}

module.exports = { connect };
