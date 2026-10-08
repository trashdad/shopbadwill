// src/ports holds TypeScript interfaces only (no runtime code, no browser
// APIs). The single exception is errors.ts: the §3 `export class` errors,
// which every thrower and catcher must share for `instanceof` to work.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import * as alarms from '../../../src/ports/alarms';
import * as calendar from '../../../src/ports/calendar';
import * as clock from '../../../src/ports/clock';
import * as errors from '../../../src/ports/errors';
import * as globalSwitches from '../../../src/ports/global-switches';
import * as googleAuth from '../../../src/ports/google-auth';
import * as http from '../../../src/ports/http';
import * as keepAlive from '../../../src/ports/keep-alive';
import * as keepAwake from '../../../src/ports/keep-awake';
import * as notifier from '../../../src/ports/notifier';
import * as permissions from '../../../src/ports/permissions';
import * as requestScheduler from '../../../src/ports/request-scheduler';
import * as sgwApi from '../../../src/ports/sgw-api';
import * as sgwClock from '../../../src/ports/sgw-clock';
import * as sgwDom from '../../../src/ports/sgw-dom';
import * as sgwHealth from '../../../src/ports/sgw-health';
import * as sgwSession from '../../../src/ports/sgw-session';
import * as snipeHost from '../../../src/ports/snipe-host';
import * as storage from '../../../src/ports/storage';

const PORTS_DIR = path.join(import.meta.dirname, '..', '..', '..', 'src', 'ports');

const INTERFACE_MODULES: Record<string, object> = {
  'alarms.ts': alarms,
  'calendar.ts': calendar,
  'clock.ts': clock,
  'global-switches.ts': globalSwitches,
  'google-auth.ts': googleAuth,
  'http.ts': http,
  'keep-alive.ts': keepAlive,
  'keep-awake.ts': keepAwake,
  'notifier.ts': notifier,
  'permissions.ts': permissions,
  'request-scheduler.ts': requestScheduler,
  'sgw-api.ts': sgwApi,
  'sgw-clock.ts': sgwClock,
  'sgw-dom.ts': sgwDom,
  'sgw-health.ts': sgwHealth,
  'sgw-session.ts': sgwSession,
  'snipe-host.ts': snipeHost,
  'storage.ts': storage,
};

describe('src/ports', () => {
  it('has exactly these port files', () => {
    const files = readdirSync(PORTS_DIR).filter((file) => file.endsWith('.ts'));
    expect([...files].sort()).toEqual([...Object.keys(INTERFACE_MODULES), 'errors.ts'].sort());
  });

  it.each(Object.entries(INTERFACE_MODULES))('%s exports no runtime values', (_file, mod) => {
    expect(Object.keys(mod)).toEqual([]);
  });

  it('errors.ts exports exactly the five error classes', () => {
    expect(Object.keys(errors).sort()).toEqual([
      'CalendarApiError',
      'GoogleAuthError',
      'HttpNetworkError',
      'HttpTimeoutError',
      'SgwApiError',
    ]);
  });
});
