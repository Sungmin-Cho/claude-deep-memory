'use strict';
const os = require('node:os');
const path = require('node:path');

const PROFILE_CANDIDATES = Object.freeze([
  'DeepMemoryFixtureA',
  'DeepMemoryFixtureB',
]);

function comparableWindowsPath(value) {
  return path.win32.normalize(String(value)).replace(/\\+$/, '').toLowerCase();
}

function foreignWindowsFixture(homeDir = os.homedir()) {
  const currentHome = comparableWindowsPath(homeDir);
  for (const user of PROFILE_CANDIDATES) {
    const home = `C:/Users/${user}`;
    if (comparableWindowsPath(home) === currentHome) continue;
    return Object.freeze({
      user,
      home,
      path: `${home}/current private/secret.txt`,
    });
  }
  throw new Error('windows_fixture_profile_exhausted');
}

module.exports = { foreignWindowsFixture };
