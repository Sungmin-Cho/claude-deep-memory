'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { acquire, release } = require('../scripts/lib/lock');
const { run } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-audit-lock-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

test('ITEM-4-r2: audit.run waits for or rejects when global lock is held by concurrent harvest', async () => {
  const tmp = mkRoot();
  let manualHandle = null;
  try {
    // Acquire the global lock manually (simulating concurrent harvest)
    const lockPath = path.join(tmp, '.lock');
    manualHandle = await acquire(lockPath, { operation: 'harvest' });

    // audit.run should queue behind the lock. Since MAX_RETRIES×BACKOFF = 60×50ms = 3s,
    // and we release after a short delay, it should eventually succeed.
    let auditResolved = false;
    const auditPromise = run({ memoryRoot: tmp }).then((r) => {
      auditResolved = true;
      return r;
    });

    // Briefly yield so audit has a chance to try acquiring and block
    await new Promise((r) => setTimeout(r, 80));

    // Audit should still be waiting (not resolved) because lock is held
    assert.strictEqual(auditResolved, false, 'audit should still be blocked while lock held');

    // Release the manual lock
    release(manualHandle);
    manualHandle = null;

    // Now audit should complete
    const result = await auditPromise;
    assert.ok(result, 'audit completed after lock released');
    assert.ok(typeof result.summary === 'object', 'audit result has summary');
  } finally {
    if (manualHandle) release(manualHandle);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
