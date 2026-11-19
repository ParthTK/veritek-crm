// After an update, a tab opened before it still has the old version, which asks for page files the server no
// longer has. Such a tab reloads once to pick up the new version instead of failing. If a file is still missing
// right after that reload, the error goes on to the error screen rather than reloading again.
const KEY = 'veritek.reloaded-for-update';
const WINDOW_MS = 30000;

function reloadedRecently() {
  try {
    return Date.now() - (Number(sessionStorage.getItem(KEY)) || 0) < WINDOW_MS;
  } catch {
    return true; // storage blocked: never risk a reload loop
  }
}

/** Wraps a dynamic import so that a file missing after an update reloads the tab (once) instead of failing. */
export function loadFresh(load) {
  return () => load().catch((err) => {
    if (reloadedRecently()) throw err;
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      throw err;
    }
    window.location.reload();
    return new Promise(() => {}); // keep showing the spinner until the new version loads
  });
}

/** True for the errors browsers give when a page file cannot be fetched. */
export const isMissingUpdate = (err) => /dynamically imported module|importing a module script failed|error loading dynamically imported|failed to fetch/i.test(String(err?.message || err || ''));
