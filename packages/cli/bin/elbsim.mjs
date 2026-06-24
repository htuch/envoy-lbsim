#!/usr/bin/env node
// Thin launcher: register tsx so the TypeScript CLI and its workspace `.ts`
// imports run directly, then dispatch to main(). Lives outside src/ so it is
// not under the coverage gate.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exit(await main(process.argv.slice(2)));
