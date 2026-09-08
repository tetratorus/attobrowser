'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const patch = fs.readFileSync(path.join(__dirname, 'cdpkit-chrome-driver.patch'), 'utf8');
function patchedCode(file) {
  const block = patch.split(`diff --git a/${file} b/${file}\n`)[1].split('\ndiff --git ')[0];
  return block.split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || line.startsWith(' '))
    .map(line => line.slice(1)).join('\n');
}
const primitives = patchedCode('primitives.js');
function primitive(name, end, globals) {
  const code = primitives.slice(primitives.indexOf(`async function ${name}(`), primitives.indexOf(end));
  return vm.runInNewContext(code + `\n${name}`, globals);
}

test('descriptor locators exclude hidden matches unless explicitly requested', () => {
  class Element {
    closest() { return null; }
    checkVisibility() { return false; }
  }
  const hidden = new Element();
  const module = { exports: {} };
  vm.runInNewContext(patchedCode('dom.js'), { module, window: {}, Element, document: { querySelectorAll: () => [hidden] } });
  const helpers = module.exports.pageHelpers();
  assert.equal(helpers.resolveAll({ selector: '#hidden' }).length, 0);
  assert.equal(helpers.resolveAll({ selector: '#hidden', visible: false }).length, 1);
});

test('native selection honors settle and allows opting out', async () => {
  let settled = 0;
  const select = primitive('select', 'async function waitFor(', {
    evalWithHelpers: async () => ({ native: true, value: 'chosen' }),
    waitForStable: async () => { settled++; },
  });
  await select({}, '#select', 'chosen');
  assert.equal(settled, 1);
  await select({}, '#select', 'chosen', { settle: false });
  assert.equal(settled, 1);
});

test('append typing rejects a framework-controlled value rollback', async () => {
  let value = 'A';
  const element = {
    isContentEditable: false,
    get value() { return value; },
    set value(next) { value = next; },
    dispatchEvent() { value = 'A'; },
  };
  let evaluations = 0;
  const type = primitive('type', 'const KEYS =', {
    transport: { call: async () => {} },
    evalWithHelpers: async (client, body, args) => {
      if (++evaluations === 1) return { editable: false, focused: true, value: 'A' };
      return vm.runInNewContext(`(function(){${body}})()`, { h: { resolve: () => element }, args, Event: class {} });
    },
  });
  await assert.rejects(type({}, '#controlled', 'X', { clear: false, settle: false }), /type\(\) failed/);
  assert.equal(value, 'A');
});

test('append typing verifies the whole expected value after insertText', async () => {
  const element = { isContentEditable: false, value: 'XA', dispatchEvent() {} };
  let evaluations = 0;
  const type = primitive('type', 'const KEYS =', {
    transport: { call: async () => {} },
    evalWithHelpers: async (client, body, args) => {
      if (++evaluations === 1) return { editable: false, focused: true, value: 'A' };
      return vm.runInNewContext(`(function(){${body}})()`, { h: { resolve: () => element }, args, Event: class {} });
    },
  });
  await type({}, '#input', 'X', { clear: false, settle: false });
  assert.equal(element.value, 'AX');
});
