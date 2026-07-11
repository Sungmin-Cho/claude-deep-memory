'use strict';

function truncateUtf8(value, maxBytes = 4096) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer');
  }
  const chunks = [];
  let used = 0;
  for (const codePoint of String(value)) {
    const width = Buffer.byteLength(codePoint, 'utf8');
    if (used + width > maxBytes) break;
    chunks.push(codePoint);
    used += width;
  }
  return chunks.join('');
}

module.exports = { truncateUtf8 };
