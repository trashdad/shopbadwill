import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Settings } from '../../../../domain/settings/schema';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import { Money } from '../../../../ui/money';
import type { SectionDef, SectionProps } from '../../registry';

const ZIP = /^\d{5}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function SettingsSection(props: SectionProps): VNode {
  const { client } = props;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<{ message: string; tone: 'ok' | 'error' }>({ message: '', tone: 'ok' });
  const [zip, setZip] = useState('');
  const [zipError, setZipError] = useState<string | undefined>(undefined);

  useEffect(() => {
    client.send('settings.get', undefined).then(
      (s) => {
        setSettings(s);
        setZip(s.homeZip ?? '');
      },
      (e: unknown) => {
        setLoadError(`Could not load your settings. ${describeError(e)}`);
      },
    );
  }, [client]);

  /**
   * Sends whole top-level groups (never half a group), keeps the change
   * on screen right away, and puts it back if the background refuses.
   */
  const save = (patch: Partial<Settings>, what: string): void => {
    if (settings === null) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    client.send('settings.set', patch).then(
      () => {
        setStatus({ message: `Saved: ${what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setSettings((cur) => (cur === null ? cur : { ...cur, ...pick(previous, patch) }));
        setStatus({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  if (settings === null) {
    return loadError === '' ? <p>Loading your settings...</p> : <Status message={loadError} tone="error" />;
  }
  const s = settings;

  const submitZip = (e: Event): void => {
    e.preventDefault();
    const value = zip.trim();
    if (!ZIP.test(value)) {
      setZipError('Enter a 5-digit ZIP code, such as 44114.');
      return;
    }
    setZipError(undefined);
    save({ homeZip: value }, 'home ZIP');
  };

  return (
    <div class="sbw-settings">
      <Status message={status.message} tone={status.tone} />

      <Card>
        <h3>Where you are</h3>
        <form onSubmit={submitZip} noValidate>
          <Field
            id="set-zip"
            label="Home ZIP"
            hint="Used for shipping estimates. It stays on this device and is sent only to ShopGoodwill when it quotes shipping."
            error={zipError}
          >
            {(c) => (
              <input
                {...c}
                type="text"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={5}
                value={zip}
                onInput={(e) => {
                  setZip(e.currentTarget.value);
                }}
              />
            )}
          </Field>
          <button type="submit">Save ZIP</button>
        </form>
        <p class="sbw-hint">Times are shown in {s.locale.timeZone}, alongside Pacific time (ShopGoodwill's clock).</p>
      </Card>

      <Card>
        <h3>Daily run</h3>
        <Switch
          id="set-daily"
          label="Run my watches every day"
          hint="Checks your saved searches once a day and tells you what is new."
          checked={s.dailyRun.enabled}
          onChange={(enabled) => {
            save({ dailyRun: { ...s.dailyRun, enabled } }, 'daily run');
          }}
        />
        <Field id="set-time" label={`Run time (${s.locale.timeZone})`} hint="Default is 07:00.">
          {(c) => (
            <input
              {...c}
              type="time"
              value={s.dailyRun.localTime}
              disabled={!s.dailyRun.enabled}
              onChange={(e) => {
                const localTime = e.currentTarget.value;
                if (TIME.test(localTime)) save({ dailyRun: { ...s.dailyRun, localTime } }, 'run time');
              }}
            />
          )}
        </Field>
        <Switch
          id="set-catchup"
          label="Catch up if the browser was closed"
          hint="Runs missed checks when the browser next starts."
          checked={s.dailyRun.catchUp}
          disabled={!s.dailyRun.enabled}
          onChange={(catchUp) => {
            save({ dailyRun: { ...s.dailyRun, catchUp } }, 'catch-up');
          }}
        />
      </Card>

      <Card>
        <h3>On the ShopGoodwill page</h3>
        <Switch
          id="set-overlay"
          label="Mark up listings on ShopGoodwill"
          hint="Turns the highlighting, hiding and badges on or off."
          checked={s.overlay.enabled}
          onChange={(enabled) => {
            save({ overlay: { ...s.overlay, enabled } }, 'page markup');
          }}
        />
        <fieldset class="sbw-inline-fieldset">
          <legend>Hidden listings</legend>
          {(
            [
              ['collapse', 'Collapse them out of the way'],
              ['dim', 'Dim them but keep them in place'],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="hide-style"
                value={value}
                checked={s.overlay.hideStyle === value}
                onChange={() => {
                  save({ overlay: { ...s.overlay, hideStyle: value } }, 'hidden-listing style');
                }}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <Switch
          id="set-quickfav"
          label="Quick favorite button"
          hint="Adds a one-click favorite to listing cards."
          checked={s.overlay.quickFavorite}
          onChange={(quickFavorite) => {
            save({ overlay: { ...s.overlay, quickFavorite } }, 'quick favorite');
          }}
        />
        <Switch
          id="set-lcbadges"
          label="Show landed-cost badges"
          hint="Only shows when landed cost (below) is on."
          checked={s.overlay.landedCostBadges}
          onChange={(landedCostBadges) => {
            save({ overlay: { ...s.overlay, landedCostBadges } }, 'landed-cost badges');
          }}
        />
        <Switch
          id="set-countdown"
          label="Show a countdown on listings"
          checked={s.overlay.countdown}
          onChange={(countdown) => {
            save({ overlay: { ...s.overlay, countdown } }, 'countdown');
          }}
        />
      </Card>

      <Card>
        <h3>Dry run (practice mode)</h3>
        <p class="sbw-hint">
          While a dry run is On, ShopBadwill shows what it would do and changes nothing on ShopGoodwill or Google. Turn one Off only when you want the real thing.
        </p>
        <Switch
          id="set-dry-fav"
          label="Dry run: favorites"
          checked={s.dryRun.favorites}
          onChange={(favorites) => {
            save({ dryRun: { ...s.dryRun, favorites } }, 'favorites dry run');
          }}
        />
        <Switch
          id="set-dry-cal"
          label="Dry run: calendar"
          checked={s.dryRun.calendar}
          onChange={(calendar) => {
            save({ dryRun: { ...s.dryRun, calendar } }, 'calendar dry run');
          }}
        />
        <Switch
          id="set-dry-bid"
          label="Dry run: bidding"
          checked={s.dryRun.bidding}
          onChange={(bidding) => {
            save({ dryRun: { ...s.dryRun, bidding } }, 'bidding dry run');
          }}
        />
      </Card>

      <Card>
        <h3>Features</h3>
        <fieldset class="sbw-inline-fieldset">
          <legend>Considerate mode</legend>
          <p class="sbw-hint" id="considerate-hint">
            Normal: ShopBadwill's standard daily request budgets and spacing. Tight: halves ShopBadwill's daily request budgets and doubles the time between background requests to ShopGoodwill. Use it if you want the lightest possible footprint.
          </p>
          {(
            [
              ['normal', 'Normal'],
              ['tight', 'Tight'],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="considerate"
                value={value}
                checked={s.considerateMode === value}
                aria-describedby="considerate-hint"
                onChange={() => {
                  save({ considerateMode: value }, 'considerate mode');
                }}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <Switch
          id="set-landed"
          label="Landed cost"
          hint="Estimates bid + shipping + handling to your ZIP; makes extra requests to ShopGoodwill."
          checked={s.features.landedCost}
          onChange={(landedCost) => {
            save({ features: { ...s.features, landedCost } }, 'landed cost');
          }}
        />
        {s.features.landedCost && s.homeZip === undefined ? (
          <p class="sbw-warn">
            <strong>Note:</strong> landed cost needs a home ZIP. Add one above.
          </p>
        ) : null}
        <Switch
          id="set-countdown-refresh"
          label="Refresh countdowns from ShopGoodwill's clock"
          hint="Keeps on-page countdowns accurate; makes a few extra requests."
          checked={s.features.countdownRefresh}
          onChange={(countdownRefresh) => {
            save({ features: { ...s.features, countdownRefresh } }, 'countdown refresh');
          }}
        />
      </Card>

      <Card>
        <h3>Spending limits</h3>
        <p class="sbw-hint">These guard any future bidding feature. They are shown here for reference and cannot be changed on this page.</p>
        <dl class="sbw-caps">
          <dt>Most for one item</dt>
          <dd>
            <Money cents={s.snipe.caps.perItemMax} />
          </dd>
          <dt>Most per day</dt>
          <dd>
            <Money cents={s.snipe.caps.perDayMax} />
          </dd>
          <dt>Most open at once</dt>
          <dd>
            <Money cents={s.snipe.caps.openExposureMax} />
          </dd>
        </dl>
      </Card>
    </div>
  );
}

/** The values of `source` for the top-level keys present in `patch`. */
function pick(source: Settings, patch: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof Settings)[]) out[key] = source[key];
  return out;
}

export const section: SectionDef = { id: 'settings', title: 'Settings', order: 20, Component: SettingsSection };
