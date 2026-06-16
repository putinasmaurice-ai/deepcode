// Shared test setup. Runs for EVERY test file in its environment, so each stub is guarded to be a
// no-op under the node environment (where `Element` is undefined) and only patches the jsdom gaps
// that Electron's real Chromium provides but jsdom does not.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function (): void {
      /* jsdom has no layout — no-op (Chromium implements this) */
    }
  }
}
