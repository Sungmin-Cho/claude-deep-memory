#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import runtime from './lib/mcp-server-runtime.js';

const { startMcpServer } = runtime;

startMcpServer({ entryDir: path.dirname(fileURLToPath(import.meta.url)) });
