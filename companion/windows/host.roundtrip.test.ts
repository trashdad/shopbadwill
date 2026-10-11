import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Protocol round-trip test for the Windows wake-and-launch companion host.
// It drives the REAL PowerShell host (companion/windows/host/shopbadwill-host.ps1)
// over the native-messaging framing (4-byte little-endian length + UTF-8 JSON)
// with a stubbed schtasks.cmd, so no scheduled task is ever created on the test
// machine (controller ruling R1). Only runs on Windows; skipped elsewhere.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOST_PS1 = path.join(REPO_ROOT, 'companion', 'windows', 'host', 'shopbadwill-host.ps1');

const MAX_FRAME = 1_048_576;

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('frame too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

interface Pending {
  resolve: (obj: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

function connect(child: ChildProcessWithoutNullStreams): {
  send: (message: unknown) => Promise<Record<string, unknown>>;
  read: () => Promise<Record<string, unknown>>;
  close: () => Promise<number | null>;
} {
  let buffer = Buffer.alloc(0);
  const requests: Pending[] = [];
  const readers: Pending[] = [];

  const deliver = (obj: Record<string, unknown>): void => {
    const next = requests.shift() ?? readers.shift();
    if (next) next.resolve(obj);
  };
  const fail = (err: Error): void => {
    for (const p of [...requests.splice(0), ...readers.splice(0)]) p.reject(err);
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME) {
        fail(new Error(`host sent an oversized frame (${String(length)} bytes)`));
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      const text = body.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        fail(new Error(`host sent invalid JSON: ${text}`));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail(new Error(`host sent a non-object message: ${text}`));
        return;
      }
      deliver(parsed as Record<string, unknown>);
    }
  });

  return {
    send(message: unknown): Promise<Record<string, unknown>> {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        requests.push({ resolve, reject });
        child.stdin.write(frame(message));
      });
    },
    read(): Promise<Record<string, unknown>> {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        readers.push({ resolve, reject });
      });
    },
    close(): Promise<number | null> {
      return new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          resolve(code);
        });
        child.stdin.end();
      });
    },
  };
}

interface WakeResponse {
  ok?: unknown;
  op?: unknown;
  error?: unknown;
  taskName?: unknown;
  wakeAtUtc?: unknown;
  tasks?: unknown;
}

describe.skipIf(process.platform !== 'win32')(
  'companion host protocol round-trip (Windows)',
  { timeout: 30_000 },
  () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sbw-companion-'));
  const fakeSchtasks = path.join(tmp, 'fake-schtasks.cmd');
  const schtasksLog = path.join(tmp, 'schtasks.log');
  const dataDir = path.join(tmp, 'data');
  const configPath = path.join(tmp, 'config.json');
  let child: ChildProcessWithoutNullStreams;
  let client: ReturnType<typeof connect>;
  const wakeAtUtc = new Date(Date.now() + 3_600_000).toISOString();

  const spawnHost = (): ChildProcessWithoutNullStreams =>
    spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_PS1, '-ConfigPath', configPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

  beforeAll(() => {
    mkdirSync(dataDir, { recursive: true });
    // Stub for schtasks: records the exact argument array (one line per call)
    // and always exits 0. The host never sees the real schtasks.
    const fake = `@echo off\r\n>>"${schtasksLog}" echo %*\r\nexit /b 0\r\n`;
    writeFileSync(fakeSchtasks, fake, 'ascii');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          dataDir,
          schtasksPath: fakeSchtasks,
          chrome: { exePath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', profile: 'Default' },
          firefox: {
            exePath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
            profile: 'default-release',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    child = spawnHost();
    client = connect(child);
  }, 30_000);

  afterAll(async () => {
    // The final test already closed stdin, so the host may have exited.
    if (child.exitCode === null) {
      try {
        await client.close();
      } catch {
        // The host may already have exited; nothing to clean up.
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }, 30_000);

  it('list on a fresh host returns an empty task list', async () => {
    const resp = (await client.send({ op: 'list' })) as WakeResponse;
    expect(resp.ok).toBe(true);
    expect(resp.op).toBe('list');
    expect(resp.tasks).toEqual([]);
  });

  it('schedule creates a ShopBadwill-prefixed wake task, WakeToRun XML, and an argument-array schtasks call', async () => {
    const resp = (await client.send({
      op: 'schedule',
      snipeId: 'test123',
      wakeAtUtc,
      browser: 'chrome',
      profile: 'Default',
    })) as WakeResponse;
    expect(resp.ok).toBe(true);
    expect(resp.op).toBe('schedule');
    expect(resp.taskName).toBe('ShopBadwill-snipe-test123');
    expect(resp.wakeAtUtc).toBe(wakeAtUtc);

    // The host invoked schtasks with the exact argument array, one line per call.
    const log = readFileSync(schtasksLog, 'utf8');
    expect(log).toContain('/Create /TN ShopBadwill-snipe-test123 /XML');
    expect(log).toContain('/F');

    // The generated XML (written next to state.json) carries the wake settings.
    const xmlPath = path.join(dataDir, 'ShopBadwill-snipe-test123.xml');
    expect(existsSync(xmlPath)).toBe(true);
    const xml = readFileSync(xmlPath, 'utf16le');
    expect(xml).toContain('<WakeToRun>true</WakeToRun>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('--profile-directory=Default');
  });

  it('list now reports the scheduled task with the prefixed name', async () => {
    const resp = (await client.send({ op: 'list' })) as WakeResponse;
    expect(resp.ok).toBe(true);
    const tasks = resp.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.snipeId).toBe('test123');
    expect(tasks[0]?.taskName).toBe('ShopBadwill-snipe-test123');
    expect(tasks[0]?.wakeAtUtc).toBe(wakeAtUtc);
  });

  it('rejects untrusted messages without invoking schtasks', async () => {
    const callsBefore = readFileSync(schtasksLog, 'utf8').split(/\r?\n/).filter(Boolean).length;

    const badSnipe = (await client.send({
      op: 'schedule',
      snipeId: '../evil',
      wakeAtUtc,
      browser: 'chrome',
      profile: 'Default',
    })) as WakeResponse;
    expect(badSnipe.ok).toBe(false);
    expect(badSnipe.error).toBe('bad-request');

    const badBrowser = (await client.send({
      op: 'schedule',
      snipeId: 'abc',
      wakeAtUtc,
      browser: 'edge',
      profile: 'Default',
    })) as WakeResponse;
    expect(badBrowser.ok).toBe(false);
    expect(badBrowser.error).toBe('bad-request');

    const badProfile = (await client.send({
      op: 'schedule',
      snipeId: 'abc',
      wakeAtUtc,
      browser: 'chrome',
      profile: 'a&b',
    })) as WakeResponse;
    expect(badProfile.ok).toBe(false);
    expect(badProfile.error).toBe('bad-request');

    const pastWake = (await client.send({
      op: 'schedule',
      snipeId: 'abc',
      wakeAtUtc: new Date(Date.now() - 60_000).toISOString(),
      browser: 'chrome',
      profile: 'Default',
    })) as WakeResponse;
    expect(pastWake.ok).toBe(false);
    expect(pastWake.error).toBe('wake-in-past');

    const unknownField = (await client.send({
      op: 'list',
      snipeId: 'abc',
    })) as WakeResponse;
    expect(unknownField.ok).toBe(false);
    expect(unknownField.error).toBe('bad-request');

    const callsAfter = readFileSync(schtasksLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('cancel removes the task with a prefixed /Delete', async () => {
    const resp = (await client.send({ op: 'cancel', snipeId: 'test123' })) as WakeResponse;
    expect(resp.ok).toBe(true);
    expect(resp.taskName).toBe('ShopBadwill-snipe-test123');
    const log = readFileSync(schtasksLog, 'utf8');
    expect(log).toContain('/Delete /TN ShopBadwill-snipe-test123 /F');

    const after = (await client.send({ op: 'list' })) as WakeResponse;
    expect(after.tasks).toEqual([]);
  });

  it('exits cleanly when stdin closes', async () => {
    const code = await client.close();
    expect(code).toBe(0);
  });

  it('answers a corrupt frame with ok:false and exits', async () => {
    // A fresh host instance: the main one already exited in the previous test.
    const child2 = spawnHost();
    const client2 = connect(child2);
    child2.stdin.write(Buffer.from('not a length-prefixed frame'));
    const errFrame = await client2.read();
    expect(errFrame.ok).toBe(false);
    expect(errFrame.error).toBe('bad-request');
    const code = await new Promise<number | null>((resolve, reject) => {
      child2.once('error', reject);
      child2.once('exit', (exitCode) => {
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
  }, 30_000);
});
