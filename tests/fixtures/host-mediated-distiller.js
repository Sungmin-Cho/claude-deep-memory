'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.slice('--mode='.length) : 'valid';

function writeMarker(value) {
  if (process.env.HOST_MEDIATED_LATE_MARKER) {
    fs.writeFileSync(process.env.HOST_MEDIATED_LATE_MARKER, value);
  }
}

if (mode === 'late-marker') {
  setTimeout(() => writeMarker('descendant still alive'), 500);
  return;
}

if (mode === 'signal-ignore'
    || mode === 'stdout-overflow-ignore'
    || mode === 'stderr-overflow-ignore') {
  process.on('SIGTERM', () => {});
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (mode === 'malformed') {
    process.stdout.write('{not-json');
    return;
  }
  if (mode === 'exit') {
    process.stderr.write('fixture failed');
    process.exitCode = 7;
    return;
  }

  const request = JSON.parse(input);
  const agentText = fs.readFileSync(request.agent_contract_path, 'utf8');
  const actualHash = createHash('sha256').update(agentText).digest('hex');
  if (actualHash !== request.agent_contract_sha256) {
    process.stderr.write('agent contract hash mismatch');
    process.exitCode = 8;
    return;
  }
  if (process.env.HOST_MEDIATED_OBSERVED) {
    fs.writeFileSync(process.env.HOST_MEDIATED_OBSERVED, JSON.stringify(request));
  }

  const response = {
    contract_version: request.contract_version,
    agent_contract_sha256: mode === 'contract-mismatch' ? '0'.repeat(64) : actualHash,
    output: mode === 'schema-invalid'
      ? { claim_refined: '', non_applicability: [], recommended_action: [], search_keywords: [] }
      : {
          claim_refined: 'Host-mediated refinement executed',
          non_applicability: [{ value: 'Do not apply to unrelated plugin formats', confidence: 0.8 }],
          recommended_action: ['Keep the authoritative contract hash attached'],
          search_keywords: ['host mediation', 'contract hash'],
        },
  };

  const write = () => process.stdout.write(JSON.stringify(response));
  if (mode === 'descendant') {
    spawn(process.execPath, [__filename, '--mode=late-marker'], {
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    setInterval(() => {}, 1000);
  } else if (mode === 'signal-ignore') setTimeout(() => {
    writeMarker('signal-ignoring mediator still alive');
    write();
  }, 500);
  else if (mode === 'stdout-overflow-ignore') {
    process.stdout.write('x'.repeat(70 * 1024));
    setTimeout(() => writeMarker('stdout-overflow mediator still alive'), 500);
  } else if (mode === 'stderr-overflow-ignore') {
    process.stderr.write('x'.repeat(10 * 1024));
    setTimeout(() => writeMarker('stderr-overflow mediator still alive'), 500);
  } else if (mode === 'timeout') setTimeout(() => {
    writeMarker('late child still alive');
    write();
  }, 250);
  else write();
});
