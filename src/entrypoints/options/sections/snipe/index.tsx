// T-91: the snipe settings section (PLAN §6 T-91, R5/R6/R7). It owns the
// enable switch, the reliability tier (T0/T1/T2), the spending caps (per-item,
// per-day, open exposure) in cents through src/domain/money.ts, the default
// lead (clamped to 6–15 s), the default fallback and the OS power guidance
// link (docs/COMPANION.md). The `background` and `power` permissions are
// requested ONLY inside the "Turn on Keep awake" click handler, through T-56's
// src/ui/permissions.ts (I-21) — never on load, never from a save. Firefox
// hides the T1 controls. This section never touches the bidding dry-run
// switch or the required/completed dry-run counters (live gating is T-102):
// turning sniping on while bidding is in dry-run keeps snipes dry-run, and it
// says so plainly (R6). Text only, no innerHTML (R7).
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { BrowserPermissions } from '../../../../adapters/browser/permissions';
import { isFirefox } from '../../../../adapters/browser/env';
import { formatCents, parseCents } from '../../../../domain/money';
import type { Settings } from '../../../../domain/settings/schema';
import type { Permissions } from '../../../../ports/permissions';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import { hasPermissions, requestPermissions } from '../../../../ui/permissions';
import type { SectionDef, SectionProps } from '../../registry';

export interface SnipeSectionProps extends SectionProps {
  /** Injectable for tests. */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
  firefox?: boolean;
}

/** The OS power guidance (docs/COMPANION.md, the S-8 note). */
const POWER_GUIDANCE_URL = 'https://github.com/trashdad/shopbadwill/blob/dev/docs/COMPANION.md';

const MIN_LEAD_SECONDS = 6;
const MAX_LEAD_SECONDS = 15;

const TIERS: ReadonlyArray<{ value: Settings['snipe']['tier']; label: string; hint: string }> = [
  {
    value: 'T0',
    label: 'T0 · Extension only',
    hint: 'The computer must be awake with the browser open when the auction ends.',
  },
  {
    value: 'T1',
    label: 'T1 · Keep awake',
    hint: 'Chrome keeps the computer awake and running after the last window closes.',
  },
  {
    value: 'T2',
    label: 'T2 · Wake the computer',
    hint: 'A Windows companion wakes the computer before the end (coming in a later update).',
  },
];

type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

interface CapsText {
  perItem: string;
  perDay: string;
  exposure: string;
}

export function SnipeSection(props: SnipeSectionProps): VNode {
  const { client } = props;
  const [api] = useState(() => props.permissions ?? new BrowserPermissions());
  const firefox = props.firefox ?? isFirefox();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [leadText, setLeadText] = useState('8');
  const [capsText, setCapsText] = useState<CapsText>({ perItem: '50.00', perDay: '100.00', exposure: '200.00' });
  const [leadError, setLeadError] = useState<string | undefined>(undefined);
  const [capsError, setCapsError] = useState<string | undefined>(undefined);

  useEffect(() => {
    client.send('settings.get', undefined).then(
      (s) => {
        setSettings(s);
        setLeadText(String(s.snipe.defaultLeadMs / 1000));
        setCapsText({
          perItem: formatCents(s.snipe.caps.perItemMax),
          perDay: formatCents(s.snipe.caps.perDayMax),
          exposure: formatCents(s.snipe.caps.openExposureMax),
        });
      },
      (e: unknown) => {
        setLoadError(`Could not load your settings. ${describeError(e)}`);
      },
    );
    void hasPermissions(api, ['power', 'background']).then((ok) => {
      setGranted(ok ? 'yes' : 'no');
    });
  }, [client, api]);

  if (settings === null) {
    return loadError === '' ? <p>Loading your settings...</p> : <Status message={loadError} tone="error" />;
  }
  const sn: Settings['snipe'] = settings.snipe;

  const saveSnipe = (next: Settings['snipe'], what: string): void => {
    const previous = settings;
    setSettings({ ...settings, snipe: next });
    client.send('settings.set', { snipe: next }).then(
      () => {
        setStatus({ message: `Saved: ${what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setSettings(previous);
        setStatus({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  // The permission prompt needs the click's gesture (I-21): the request is the
  // first thing that happens, before any await, through src/ui/permissions.ts.
  const allow = (): void => {
    void requestPermissions(api, ['background', 'power']).then((r) => {
      if (r.kind === 'granted') {
        setGranted('yes');
        setStatus({ message: 'Keep awake is on: Chrome may keep the computer awake and start at login.', tone: 'ok' });
      } else if (r.kind === 'denied') {
        setGranted('no');
        setStatus({ message: 'The browser did not allow it. Nothing was changed.', tone: 'error' });
      } else {
        setStatus({ message: `Could not ask for the permissions. ${r.message}`, tone: 'error' });
      }
    });
  };

  const saveLead = (): void => {
    const text = leadText.trim();
    if (!/^\d+$/.test(text)) {
      setLeadError('Enter a whole number of seconds.');
      return;
    }
    const seconds = Math.min(MAX_LEAD_SECONDS, Math.max(MIN_LEAD_SECONDS, Number(text)));
    setLeadError(undefined);
    setLeadText(String(seconds));
    saveSnipe({ ...sn, defaultLeadMs: seconds * 1000 }, `default lead ${String(seconds)} s`);
  };

  const saveCaps = (): void => {
    const perItem = parseCents(capsText.perItem);
    const perDay = parseCents(capsText.perDay);
    const exposure = parseCents(capsText.exposure);
    if (perItem === null || perDay === null || exposure === null) {
      setCapsError('Enter each cap in dollars, like 50 or 12.99.');
      return;
    }
    setCapsError(undefined);
    setCapsText({ perItem: formatCents(perItem), perDay: formatCents(perDay), exposure: formatCents(exposure) });
    saveSnipe(
      { ...sn, caps: { ...sn.caps, perItemMax: perItem, perDayMax: perDay, openExposureMax: exposure } },
      'spending caps',
    );
  };

  const tierLabel = (value: Settings['snipe']['tier']): string => TIERS.find((t) => t.value === value)?.label ?? value;

  return (
    <div>
      <Card>
        <h3>Sniping</h3>
        <Switch
          id="snipe-enabled"
          label="Sniping"
          hint="Arms 24-hour and 1-hour health checks before each armed snipe, then bids in the final seconds."
          checked={sn.enabled}
          onChange={(v) => {
            saveSnipe({ ...sn, enabled: v }, 'sniping');
          }}
        />
        {sn.enabled && settings.dryRun.bidding ? (
          <p class="sbw-hint">
            Sniping is on, but bidding is still in dry-run mode: snipes do not place real bids. This page never turns
            live bidding on — the bidding switch and the dry-run counter are managed elsewhere.
          </p>
        ) : null}
      </Card>

      <Card>
        <h3>Timing</h3>
        <Field
          id="snipe-lead"
          label="Default lead (seconds)"
          hint={`How many seconds before the end the bid is sent. Clamped to ${String(MIN_LEAD_SECONDS)}–${String(
            MAX_LEAD_SECONDS,
          )} s.`}
          error={leadError}
        >
          {(c) => (
            <input
              {...c}
              type="text"
              inputMode="numeric"
              value={leadText}
              onInput={(e) => {
                setLeadText(e.currentTarget.value);
              }}
            />
          )}
        </Field>
        <Field
          id="snipe-fallback"
          label="Default fallback"
          hint="What to do when the snipe cannot fire in time: place the max as an early proxy bid (only with a valid session, an open bidding gate and passing caps), or skip and place no bid."
        >
          {(c) => (
            <select
              {...c}
              value={sn.defaultFallback}
              onChange={(e) => {
                const value = e.currentTarget.value;
                saveSnipe({ ...sn, defaultFallback: value === 'skip' ? 'skip' : 'early-proxy' }, 'default fallback');
              }}
            >
              <option value="early-proxy">Place an early proxy bid</option>
              <option value="skip">Skip (place no bid)</option>
            </select>
          )}
        </Field>
        <button type="button" onClick={saveLead}>
          Save timing
        </button>
      </Card>

      <Card>
        <h3>Spending caps</h3>
        <p class="sbw-hint">
          The most a snipe may bid. Caps are checked when a snipe is armed and again before any bid; they never change
          the bid you asked for, they block it.
        </p>
        <Field id="snipe-cap-item" label="Per item (USD)" hint="The most one snipe may bid." error={capsError}>
          {(c) => (
            <input
              {...c}
              type="text"
              inputMode="decimal"
              value={capsText.perItem}
              onInput={(e) => {
                setCapsText({ ...capsText, perItem: e.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field id="snipe-cap-day" label="Per day (USD)" hint="Total snipe bids in one day.">
          {(c) => (
            <input
              {...c}
              type="text"
              inputMode="decimal"
              value={capsText.perDay}
              onInput={(e) => {
                setCapsText({ ...capsText, perDay: e.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field id="snipe-cap-exposure" label="Open exposure (USD)" hint="Total open snipe bids across all active snipes.">
          {(c) => (
            <input
              {...c}
              type="text"
              inputMode="decimal"
              value={capsText.exposure}
              onInput={(e) => {
                setCapsText({ ...capsText, exposure: e.currentTarget.value });
              }}
            />
          )}
        </Field>
        <button type="button" onClick={saveCaps}>
          Save caps
        </button>
      </Card>

      <Card>
        <h3>Reliability tier</h3>
        <p class="sbw-hint">
          Nothing runs while the computer is asleep or the browser is closed. The tier says what protects a snipe then.
        </p>
        <fieldset class="sbw-inline-fieldset">
          <legend>Tier</legend>
          {TIERS.filter((t) => !(firefox && t.value === 'T1')).map((t) => (
            <label key={t.value}>
              <input
                type="radio"
                name="snipe-tier"
                value={t.value}
                checked={sn.tier === t.value}
                onChange={() => {
                  saveSnipe({ ...sn, tier: t.value }, `tier ${t.value}`);
                }}
              />{' '}
              {t.label}
              <span class="sbw-hint">{t.hint}</span>
            </label>
          ))}
        </fieldset>
        {firefox ? (
          <p class="sbw-hint">
            Firefox has no keep-awake API and no background permission, so T1 is not available here
            {sn.tier === 'T1' ? `: your saved tier ${tierLabel(sn.tier)} runs as T0 in Firefox. Pick T0 or T2.` : '.'}
          </p>
        ) : null}
      </Card>

      {!firefox ? (
        <Card>
          <h3>Keep awake (T1)</h3>
          {granted === 'yes' ? (
            <p>Keep awake is on: Chrome may keep the computer awake and start at login while a snipe is armed.</p>
          ) : (
            <>
              <p>
                T1 needs two extra permissions your browser asks for separately: <code>background</code> (Chrome keeps
                running after the last window closes) and <code>power</code> (Chrome keeps the computer awake).
              </p>
              <button type="button" onClick={allow}>
                Turn on Keep awake
              </button>
            </>
          )}
        </Card>
      ) : null}

      <Card>
        <h3>Power guidance</h3>
        <p class="sbw-hint">
          Even with keep-awake, manual sleep, closing the lid or an update restart can end a snipe. Keep the computer
          plugged in during the auction, and let Windows stay awake on AC while you rely on sniping.
        </p>
        <p>
          <a href={POWER_GUIDANCE_URL} target="_blank" rel="noopener noreferrer">
            OS power guidance (docs/COMPANION.md)
          </a>
        </p>
      </Card>
      <Status message={status.message} tone={status.tone} />
    </div>
  );
}

export const section: SectionDef = {
  id: 'snipe',
  title: 'Sniping',
  order: 28,
  Component: SnipeSection,
};
