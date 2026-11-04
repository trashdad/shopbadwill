// T-70c: options-page sections share no state, so a section that saves
// settings announces it and the others re-read `settings.get`. This is a
// same-page DOM event, not a protocol message: other contexts (popup,
// dashboard) still read settings when they open.

const EVENT = 'sbw:options-settings-saved';

/** Tell the other options sections that settings were just saved. */
export function announceSettingsSaved(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `reload` after any options section saves settings. Returns an unsubscribe. */
export function onSettingsSaved(reload: () => void): () => void {
  window.addEventListener(EVENT, reload);
  return () => {
    window.removeEventListener(EVENT, reload);
  };
}
