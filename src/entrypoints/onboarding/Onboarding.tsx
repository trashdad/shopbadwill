// T-71: the first-run onboarding wizard, five steps on one screen each:
//
//   1. Sign-in check   `health.get` → `sessionState` (detect only, R2: never a
//                      password or token; logged out → sign in on
//                      shopgoodwill.com in a normal tab, then Check again).
//   2. Home ZIP        optional; validated as a US ZIP, stored in
//                      `settings.homeZip` (R4). Skip writes nothing; it is never
//                      logged or audited.
//   3. Calendar        Connect Google opens the T-70 options section at the
//                      Google anchor; Skip for now leaves `calendar.enabled`
//                      off and `icsFallback` on, with the .ics note (R5).
//   4. First watch     the current SGW search tab, else the whole-site template;
//                      `favoriteMode` is the `Watch` schema default 'sgw'
//                      (§15 Q5) unless the user chooses not to favorite
//                      (`local`), matching everything new in the search. The
//                      preview says that once dry-run is off, every new item
//                      is favorited on the ShopGoodwill account. A stored
//                      watch for the same search (T-52 identity) is reused,
//                      never duplicated (controller ruling 2).
//   5. Dry run         plain ToS/risk copy behind an explicit checkbox (R3), the
//                      optional `notifications` permission requested from the
//                      click handler through src/ui/permissions.ts (R6, I-21),
//                      then "Dry-run it now": `job.runNow` sent only after the
//                      favorites and calendar dry runs are on (R1). Bidding
//                      dry-run is never changed (controller ruling 1).
//
// Onboarding itself never enables live sniping and never turns dry-run off (R3).
import type { VNode } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { BrowserPermissions } from '../../adapters/browser/permissions';
import type { AuthStatus } from '../../domain/calendar/types';
import { DEFAULT_WATCH_FAVORITE_MODE } from '../../domain/settings/defaults';
import type { Settings } from '../../domain/settings/schema';
import type { SearchQuery } from '../../domain/types';
import type { Watch } from '../../domain/watches/schema';
import { MessagingError } from '../../messaging/errors';
import type { MsgReply } from '../../messaging/protocol';
import type { MessagingClient } from '../../ports/messaging';
import type { Permissions } from '../../ports/permissions';
import { describeError } from '../../ui/components/describeError';
import { Card, Field } from '../../ui/components/Field';
import { Status } from '../../ui/components/Status';
import { hasPermissions, requestPermissions } from '../../ui/permissions';
import { summarizeQuery } from '../options/sections/watches';
import { MATCH_ALL_RULE_ID, defaultWatchName, matchEverythingRule, queryFromUrl } from '../options/sections/watches/draft';
import { buildFirstWatch, searchKey, templateQuery, zipError } from './steps';

export interface OnboardingProps {
  client: MessagingClient;
  /** Injectable for tests: the URL of the most recently used SGW search tab, or undefined when none is open. */
  getActiveTabUrl?: () => Promise<string | undefined>;
  /** Injectable for tests: the optional-permissions API; the request happens inside the click handler (I-21). */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
  /** Injectable for tests: opens the options page at the Google section (T-70). */
  openGoogleOptions?: () => void;
  /** Injectable for tests: opens the plain options page. */
  openOptions?: () => void;
  now?: () => number;
  newId?: () => string;
}

type Step = 1 | 2 | 3 | 4 | 5;
type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

const SIGNED_IN: ReadonlyArray<MsgReply<'health.get'>['sessionState']> = ['ok', 'expiring'];

/** Stable defaults for the injected seams: fresh closures each render would re-trigger effects. */
const NO_TAB = (): Promise<string | undefined> => Promise.resolve(undefined);
const NOOP = (): void => undefined;

/** Ruling 2: another stored watch for the same search (by T-52's identity), or null. `ownId` is this visit's watch. */
function sameSearch(all: readonly Watch[], query: SearchQuery, ownId: string): Watch | null {
  const key = searchKey(query);
  return all.find((w) => w.id !== ownId && searchKey(w.query) === key) ?? null;
}

function problem(what: string, e: unknown): string {
  if (e instanceof MessagingError && e.code === 'no_handler') {
    return `${what} The background part of the extension is not available yet; reload the extension.`;
  }
  return `${what} ${describeError(e)}`;
}

export function Onboarding(props: OnboardingProps): VNode {
  const { client } = props;
  const now = props.now ?? Date.now;
  // One id per visit: going Back and creating the watch again updates it, never adds a second.
  const [watchId] = useState(() => (props.newId ?? (() => crypto.randomUUID()))());
  const getActiveTabUrl = props.getActiveTabUrl ?? NO_TAB;
  const openGoogle = props.openGoogleOptions ?? NOOP;
  const openOptions = props.openOptions ?? NOOP;
  const [permissionsApi] = useState(() => props.permissions ?? new BrowserPermissions());

  const [step, setStep] = useState<Step>(1);
  const [done, setDone] = useState(false);
  const [checking, setChecking] = useState(true);
  const [health, setHealth] = useState<MsgReply<'health.get'> | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [zip, setZip] = useState('');
  /** The ZIP actually stored, for the summary: a typed-then-skipped ZIP was never saved. */
  const [savedZip, setSavedZip] = useState('');
  const [zipErr, setZipErr] = useState<string | undefined>(undefined);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [calNote, setCalNote] = useState('');
  const [source, setSource] = useState<{ query: SearchQuery; fromTab: boolean } | null>(null);
  /** True saves the schema default (`sgw`). False is "don't favorite" (`local`). */
  const [favoriteOnAccount, setFavoriteOnAccount] = useState(true);
  const [watch, setWatch] = useState<Watch | null>(null);
  /** A stored watch for the step-4 search, reused instead of creating another (ruling 2). */
  const [existing, setExisting] = useState<Watch | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [tos, setTos] = useState(false);
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [dryRunState, setDryRunState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  const checkHealth = useCallback(() => {
    setChecking(true);
    setHealth(null);
    setHealthFailed(false);
    client.send('health.get', undefined).then(
      (r) => {
        setHealth(r);
        setChecking(false);
      },
      () => {
        setHealthFailed(true);
        setChecking(false);
      },
    );
  }, [client]);

  useEffect(() => {
    client.send('settings.get', undefined).then(
      setSettings,
      (e: unknown) => {
        setSettingsError(problem('Could not load your settings.', e));
      },
    );
    void hasPermissions(permissionsApi, ['notifications']).then((ok) => {
      setGranted(ok ? 'yes' : 'no');
    });
  }, [client, permissionsApi]);

  // The sign-in check runs on step 1, including when the user comes back to it
  // (R2: sign in in a normal tab, then Check again).
  useEffect(() => {
    if (step === 1) checkHealth();
  }, [step, checkHealth]);

  // The calendar step reads the Google status once (T-70's flow opens options).
  useEffect(() => {
    if (step !== 3) return;
    let alive = true;
    client.send('calendar.status', undefined).then(
      (s) => {
        if (alive) setAuth(s);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, step]);

  const resolveSource = useCallback(() => {
    setSource(null);
    getActiveTabUrl().then(
      (url) => {
        if (url !== undefined) {
          const r = queryFromUrl(url);
          if (r.ok) {
            setSource({ query: r.query, fromTab: true });
            return;
          }
        }
        setSource({ query: templateQuery(), fromTab: false });
      },
      () => {
        setSource({ query: templateQuery(), fromTab: false });
      },
    );
  }, [getActiveTabUrl]);

  // The watch step resolves the search source when it opens.
  useEffect(() => {
    if (step === 4) resolveSource();
  }, [step, resolveSource]);

  // Ruling 2: is this search already watched? (createWatch checks again, fresh, on the click.)
  useEffect(() => {
    setExisting(null);
    if (source === null) return;
    let alive = true;
    client.send('watches.list', undefined).then(
      (all) => {
        if (alive) setExisting(sameSearch(all, source.query, watchId));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, source, watchId]);

  // Move focus to the step heading on every change, for screen readers.
  useEffect(() => {
    document.getElementById('onboarding-step-heading')?.focus();
  }, [step, done]);

  const signedIn = health !== null && SIGNED_IN.includes(health.sessionState);
  // A re-run can find a dry run already off; the copy must say so (the defaults are all on).
  const favoritesDryRunOff = settings !== null && !settings.dryRun.favorites;
  /** The daily job's writes; Dry-run it now turns these on. */
  const jobDryRunOn = settings === null || (settings.dryRun.favorites && settings.dryRun.calendar);
  /** Never changed by onboarding (ruling 1). */
  const biddingDryRunOn = settings === null || settings.dryRun.bidding;

  const saveZip = (): void => {
    const v = zip.trim();
    if (v === '') {
      setStep(3);
      return;
    }
    const err = zipError(v);
    if (err !== undefined) {
      setZipErr(err);
      return;
    }
    if (settings === null) {
      setZipErr(settingsError === '' ? 'Your settings have not loaded yet; try again in a moment.' : settingsError);
      return;
    }
    client.send('settings.set', { homeZip: v }).then(
      () => {
        setZipErr(undefined);
        setSavedZip(v);
        setStep(3);
      },
      (e: unknown) => {
        setZipErr(problem('Could not save your ZIP.', e));
      },
    );
  };

  const skipCalendar = (): void => {
    if (settings === null) return;
    // R5: skip leaves calendar.enabled=false and icsFallback=true, whatever was stored before.
    const calendar = { ...settings.calendar, enabled: false, icsFallback: true };
    client.send('settings.set', { calendar }).then(
      () => {
        setSettings({ ...settings, calendar });
        setCalNote(
          'Google Calendar reminders are off. You can still add single auctions to your calendar: the dashboard offers .ics downloads.',
        );
      },
      (e: unknown) => {
        setStatus({ message: problem('Could not save that.', e), tone: 'error' });
      },
    );
  };

  const createWatch = async (): Promise<void> => {
    if (source === null) return;
    setWatchBusy(true);
    setWatchError('');
    try {
      // Ruling 2: never a second watch for the same search. Checked fresh here,
      // since one may have been saved (options, another tab) after step 4 opened.
      const same = sameSearch(await client.send('watches.list', undefined), source.query, watchId);
      if (same !== null) {
        setExisting(same);
        setWatch(same);
        setStep(5);
        return;
      }
      const rules = await client.send('rules.list', undefined);
      if (!rules.some((r) => r.id === MATCH_ALL_RULE_ID)) {
        await client.send('rules.save', matchEverythingRule(now()));
      }
      const built = buildFirstWatch(
        source.query,
        now(),
        watchId,
        favoriteOnAccount ? DEFAULT_WATCH_FAVORITE_MODE : 'local',
      );
      if (!built.ok) {
        setWatchError(built.error);
        return;
      }
      await client.send('watches.save', built.watch);
      setWatch(built.watch);
      setStep(5);
    } catch (e) {
      setWatchError(problem('Could not create the watch.', e));
    } finally {
      setWatchBusy(false);
    }
  };

  const askNotifications = (): void => {
    // Synchronously in the click handler (R6, I-21): the request goes out before anything awaits.
    void requestPermissions(permissionsApi, ['notifications']).then((r) => {
      if (r.kind === 'granted') {
        setGranted('yes');
      } else if (r.kind === 'denied') {
        setGranted('no');
        setStatus({ message: 'The browser did not allow notifications. Nothing was changed.', tone: 'error' });
      } else {
        setStatus({ message: `Could not ask for notifications. ${r.message}`, tone: 'error' });
      }
    });
  };

  const dryRunNow = async (): Promise<void> => {
    if (watch === null || settings === null) return;
    setDryRunState('running');
    try {
      // R1/R3: the run goes out only while the daily job's writes (favorites,
      // calendar) are in dry-run; onboarding turns them ON, never off. Read fresh,
      // not the copy loaded with the page: the options tab (Connect Google) may
      // have changed a dry run since. Ruling 1: bidding is written back exactly as
      // stored, so armed live snipes are never silently converted.
      let current = await client.send('settings.get', undefined);
      if (!current.dryRun.favorites || !current.dryRun.calendar) {
        const dryRun = { ...current.dryRun, favorites: true, calendar: true };
        await client.send('settings.set', { dryRun });
        current = { ...current, dryRun };
      }
      setSettings(current);
      await client.send('job.runNow', { watchIds: [watch.id] });
      setDryRunState('done');
      setStatus({ message: 'The dry run is running. Watch the dashboard for progress.', tone: 'ok' });
    } catch (e) {
      setDryRunState('error');
      setStatus({ message: problem('Could not start the dry run.', e), tone: 'error' });
    }
  };

  if (done) {
    return (
      <div class="sbw-onboarding">
        <main id="sbw-main">
          <Card>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              You're all set.
            </h2>
            <ul class="sbw-checks">
              <li>Signed in to ShopGoodwill.</li>
              <li>Home ZIP: {savedZip === '' ? 'skipped' : savedZip}.</li>
              <li>Calendar: {calNote === '' ? 'as you left it.' : '.ics downloads.'}</li>
              {watch === null ? null : <li>First watch: "{watch.name}" — the dry run is running.</li>}
            </ul>
            <p class="sbw-hint">
              {biddingDryRunOn
                ? 'Dry-run stays on until you turn it off. Live bidding stays off until you turn off the bidding dry run yourself in options.'
                : 'Dry-run for favorites and calendar stays on until you turn it off. Bidding dry-run is off, as you left it: armed snipes can bid for real.'}
            </p>
            <div class="sbw-actions">
              <button
                type="button"
                onClick={() => {
                  openOptions();
                }}
              >
                Open options
              </button>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div class="sbw-onboarding">
      <a class="sbw-skip" href="#sbw-main">
        Skip to content
      </a>
      <header>
        <h1>Set up ShopBadwill</h1>
        <p class="sbw-hint" data-testid="onboarding-step">
          Step {String(step)} of 5
        </p>
      </header>
      {settingsError === '' ? null : (
        <p class="sbw-error" role="alert">
          <strong>Error:</strong> {settingsError}
        </p>
      )}
      <Status message={status.message} tone={status.tone} />
      <main id="sbw-main">
        {step === 1 ? (
          <section>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              Check your ShopGoodwill sign-in
            </h2>
            {checking && health === null ? <p>Checking your sign-in on ShopGoodwill...</p> : null}
            {healthFailed ? (
              <p class="sbw-error" role="alert">
                ShopBadwill could not check your sign-in right now. Check again in a moment.
              </p>
            ) : health === null ? null : signedIn ? (
              <div>
                <p>You are signed in to ShopGoodwill.</p>
                {health.sessionState === 'expiring' ? (
                  <p class="sbw-warn" role="note">
                    Your sign-in expires soon. Sign in again on shopgoodwill.com to keep the daily job running.
                  </p>
                ) : null}
              </div>
            ) : (
              <p class="sbw-error" role="alert">
                ShopBadwill could not see your ShopGoodwill sign-in. Sign in on shopgoodwill.com in a normal tab, then click
                Check again. ShopBadwill never asks for your password.
              </p>
            )}
            <div class="sbw-actions">
              <button
                type="button"
                disabled={!signedIn}
                onClick={() => {
                  setStep(2);
                }}
              >
                Continue
              </button>
              {signedIn ? null : (
                <button
                  type="button"
                  class="sbw-secondary"
                  disabled={checking}
                  onClick={() => {
                    checkHealth();
                  }}
                >
                  Check again
                </button>
              )}
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              Home ZIP (optional)
            </h2>
            <p>Used to estimate shipping and handling to your door. Skip it if you prefer.</p>
            <Field
              id="onboarding-zip"
              label="Home ZIP (optional)"
              hint="A 5-digit US ZIP, like 98122 (98122-1234 also works). Stored only on this device."
              error={zipErr}
            >
              {(c) => (
                <input
                  {...c}
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  value={zip}
                  onInput={(e) => {
                    setZip(e.currentTarget.value);
                    setZipErr(undefined);
                  }}
                />
              )}
            </Field>
            <div class="sbw-actions">
              <button type="button" onClick={saveZip}>
                Continue
              </button>
              <button
                type="button"
                class="sbw-secondary"
                onClick={() => {
                  setStep(3);
                }}
              >
                Skip
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              Calendar
            </h2>
            <p>
              ShopBadwill can put auction ends on a Google Calendar with reminders 60, 15 and 5 minutes before, or you can
              download .ics files for single items instead.
            </p>
            <p>
              {auth === null ? (
                'Checking Google Calendar...'
              ) : auth.connected ? (
                <strong>
                  Google Calendar is connected{auth.account === undefined ? '.' : ` as ${auth.account}.`}
                </strong>
              ) : (
                'Google Calendar is not connected yet.'
              )}
            </p>
            <div class="sbw-actions">
              <button
                type="button"
                class="sbw-secondary"
                onClick={() => {
                  openGoogle();
                }}
              >
                Connect Google
              </button>
              <button type="button" class="sbw-secondary" disabled={settings === null} onClick={skipCalendar}>
                Skip for now
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep(4);
                }}
              >
                Continue
              </button>
            </div>
            {calNote === '' ? null : (
              <p class="sbw-hint" role="status">
                {calNote}
              </p>
            )}
          </section>
        ) : null}

        {step === 4 ? (
          <section>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              Your first watch
            </h2>
            <p>A watch is a ShopGoodwill search that ShopBadwill runs for you each day.</p>
            {source === null ? (
              <p>Checking for a ShopGoodwill search tab...</p>
            ) : (
              <div>
                <p data-testid="onboarding-watch-source">
                  {source.fromTab
                    ? 'From your current ShopGoodwill search:'
                    : 'No ShopGoodwill search tab is open, so this watch starts from the whole site:'}
                </p>
                <Card>
                  <h3>{defaultWatchName(source.query)}</h3>
                  <p data-testid="onboarding-watch-query">{summarizeQuery(source.query)}</p>
                  {existing !== null ? (
                    <div>
                      <p role="status">
                        You already watch this search: "{existing.name}". ShopBadwill will not create another.
                      </p>
                      <p>
                        {existing.favoriteMode === 'local'
                          ? 'It does not favorite anything on your ShopGoodwill account.'
                          : favoritesDryRunOff
                            ? 'Dry-run is off for favorites right now, so it favorites new items on your ShopGoodwill account when it runs.'
                            : 'Once dry-run is off, it favorites new items on your ShopGoodwill account.'}
                      </p>
                      {existing.enabled ? null : (
                        <p class="sbw-warn">It is turned off, so the dry run cannot run it. Turn it on in options first.</p>
                      )}
                    </div>
                  ) : (
                    <div>
                      <p>
                        {!favoriteOnAccount
                          ? 'Nothing in this search will be favorited on your ShopGoodwill account.'
                          : favoritesDryRunOff
                            ? "Dry-run is off for favorites right now, so from this watch's next run, every new item in this search will be favorited on your ShopGoodwill account. Dry-run it now, on the next step, turns dry-run back on."
                            : 'Once dry-run is off, every new item in this search will be favorited on your ShopGoodwill account.'}
                      </p>
                      <p class="sbw-hint">
                        It matches everything new in this search. You can add rules, sellers and price limits later in options.
                      </p>
                      <label>
                        <input
                          type="checkbox"
                          checked={!favoriteOnAccount}
                          onChange={(e) => {
                            setFavoriteOnAccount(!e.currentTarget.checked);
                          }}
                        />{' '}
                        Don't favorite on ShopGoodwill
                      </label>
                    </div>
                  )}
                </Card>
                <div class="sbw-actions">
                  <button
                    type="button"
                    class="sbw-secondary"
                    onClick={() => {
                      resolveSource();
                    }}
                  >
                    Use my current search
                  </button>
                  <button
                    type="button"
                    disabled={watchBusy}
                    onClick={() => {
                      void createWatch();
                    }}
                  >
                    {existing === null ? 'Create my first watch' : 'Use this watch'}
                  </button>
                </div>
              </div>
            )}
            {watchError === '' ? null : (
              <p class="sbw-error" role="alert">
                <strong>Error:</strong> {watchError}
              </p>
            )}
            <div class="sbw-actions">
              <button
                type="button"
                class="sbw-secondary"
                onClick={() => {
                  setStep(3);
                }}
              >
                Back
              </button>
            </div>
          </section>
        ) : null}

        {step === 5 ? (
          <section>
            <h2 id="onboarding-step-heading" tabIndex={-1}>
              Dry-run it now
            </h2>
            <Card class="sbw-warn">
              <h3>Straight talk about risk</h3>
              <ul class="sbw-checks">
                <li>Automated bidding may break ShopGoodwill's terms, and your account is at risk. Real money is involved.</li>
                <li>You keep control: every bid is capped by the max you set, and daily caps apply.</li>
                <li>
                  {jobDryRunOn && biddingDryRunOn
                    ? 'Dry-run is on and stays on until you turn it off yourself.'
                    : `${
                        jobDryRunOn
                          ? 'Dry-run is on for favorites and calendar and stays on until you turn it off yourself.'
                          : 'Dry-run is off right now for favorites or calendar. Dry-run it now turns it back on for both, and it stays on until you turn it off yourself.'
                      } ${
                        biddingDryRunOn
                          ? 'Bidding dry-run is on and stays on until you turn it off yourself.'
                          : 'Bidding dry-run is off, as you set it: armed snipes can bid for real. Dry-run it now leaves it that way.'
                      }`}
                </li>
              </ul>
              <label>
                <input
                  id="onboarding-tos"
                  type="checkbox"
                  checked={tos}
                  onChange={(e) => {
                    setTos(e.currentTarget.checked);
                  }}
                />{' '}
                I understand the risks.
              </label>
            </Card>
            <Card>
              <h3>Notifications (optional)</h3>
              {granted === 'yes' ? (
                <p>Notifications are allowed.</p>
              ) : (
                <div>
                  <p>ShopBadwill can tell you about new matches and auctions ending soon.</p>
                  <button type="button" onClick={askNotifications}>
                    Allow notifications
                  </button>
                </div>
              )}
            </Card>
            <Card>
              <h3>The dry run</h3>
              {watch === null || watch.id === watchId ? null : (
                <p>You already watch this search, so the dry run uses "{watch.name}" as it is.</p>
              )}
              {watch === null ? null : (
                <p>
                  Runs "{watch.name}" now: matches are found and favorited only on paper. Nothing is written to your
                  ShopGoodwill account.
                </p>
              )}
              <div class="sbw-actions">
                <button
                  type="button"
                  disabled={
                    !tos || settings === null || watch === null || dryRunState === 'running' || dryRunState === 'done'
                  }
                  onClick={() => {
                    void dryRunNow();
                  }}
                >
                  Dry-run it now
                </button>
                {dryRunState === 'done' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDone(true);
                    }}
                  >
                    Finish
                  </button>
                ) : null}
              </div>
            </Card>
            <div class="sbw-actions">
              <button
                type="button"
                class="sbw-secondary"
                disabled={dryRunState === 'running'}
                onClick={() => {
                  setStep(4);
                }}
              >
                Back
              </button>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
