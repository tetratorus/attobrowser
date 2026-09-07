const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function statePath() {
  return path.resolve("attobrowser-state.json");
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function load() {
  const file = statePath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid state in ${file}: expected JSON`);
  }
  if (!state || !validPort(state.port) || typeof state.targetId !== "string" || !state.targetId.trim()) {
    throw new Error(`Invalid state in ${file}: expected port and targetId`);
  }
  return { port: state.port, targetId: state.targetId };
}

function save(state) {
  const file = statePath();
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { statePath, validPort, load, save };
