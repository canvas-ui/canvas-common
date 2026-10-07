#!/usr/bin/env node
import { main } from '../src/main.js';
main({ kind: 'agent' }).catch(error => { console.error(error.message); process.exitCode = 1; });
