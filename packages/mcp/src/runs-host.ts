#!/usr/bin/env node
import { encode, frames, receiveRun, type RunReply } from './runs.js';

const dir = process.argv[2];

async function reply(): Promise<RunReply> {
  if (!dir) return { ok: false, error: 'No runs folder given' };

  try {
    return await receiveRun(dir, frames(process.stdin));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

process.stdout.write(encode(await reply()), () => process.exit(0));
