/**
 * device.js — what kind of thing is this app open on?
 *
 * A guest account in this app has no password until its owner asks for
 * one, so the account effectively *is* the device it was claimed on.
 * That makes the device label load-bearing rather than cosmetic — it
 * ends up in three places a person actually reads:
 *
 *   - their display name         "Sam Rivera (iPhone)"
 *   - their Matrix device name   "iPhone · Safari"
 *   - the members list           "joined from iPhone"
 *
 * Everything here is a pure function of a user-agent string (plus the
 * optional `navigator.userAgentData` hints, which are more reliable on
 * Chromium) so it is testable off-browser. Detection is deliberately
 * coarse: we want "iPhone", not a version matrix. Unknown is "device",
 * which reads fine in every one of the sentences above.
 */

const UNKNOWN = 'device';

/**
 * Coarse device class from a UA string.
 *
 * @param {string} [ua]   - defaults to navigator.userAgent
 * @param {object} [hints]- navigator.userAgentData-shaped { platform, mobile }
 * @returns {string} e.g. "iPhone", "iPad", "Android phone", "Mac",
 *   "Windows PC", "Chromebook", "Linux PC", or "device"
 */
export function deviceLabel(ua, hints) {
  const s = String(ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '') ?? '');
  const platform = String(hints?.platform || '');
  const mobileHint = hints?.mobile === true;

  // iPadOS 13+ reports a desktop Safari UA. The tell is a "Mac" UA on a
  // touch device — no other Mac reports touch points.
  const touchMac = /Macintosh/i.test(s)
    && typeof navigator !== 'undefined'
    && (navigator.maxTouchPoints || 0) > 1;

  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s) || touchMac) return 'iPad';
  if (/iPod/i.test(s)) return 'iPod';
  if (/Android/i.test(s) || platform === 'Android') {
    return (/Mobile/i.test(s) || mobileHint) ? 'Android phone' : 'Android tablet';
  }
  if (/CrOS/i.test(s) || platform === 'Chrome OS') return 'Chromebook';
  if (/Macintosh|Mac OS X/i.test(s) || platform === 'macOS') return 'Mac';
  if (/Windows/i.test(s) || platform === 'Windows') return 'Windows PC';
  if (/Linux|X11/i.test(s) || platform === 'Linux') return 'Linux PC';
  return UNKNOWN;
}

/**
 * Coarse browser name. Order matters: several browsers carry the
 * strings of the ones they were forked from, so the most specific
 * marker has to be tested first (Edge before Chrome, Chrome before
 * Safari).
 */
export function browserLabel(ua) {
  const s = String(ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '') ?? '');
  if (/Edg\//i.test(s)) return 'Edge';
  if (/OPR\/|Opera/i.test(s)) return 'Opera';
  if (/SamsungBrowser/i.test(s)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS/i.test(s)) return 'Firefox';
  if (/CriOS/i.test(s)) return 'Chrome';
  if (/Chrome\//i.test(s)) return 'Chrome';
  if (/Safari\//i.test(s)) return 'Safari';
  return '';
}

/** Matrix device display name: "iPhone · Safari" (or just the device). */
export function deviceDisplayName(ua, hints) {
  const dev = deviceLabel(ua, hints);
  const br = browserLabel(ua);
  return br ? `${dev} · ${br}` : dev;
}

/**
 * The account name a claimed guest gets: what they typed, plus where
 * they typed it. Two people who both answer "Sam" are then still
 * distinguishable in a members list, and the owner can see at a glance
 * which of their devices first claimed the account.
 *
 * Already-suffixed names pass through unchanged, so re-running this on
 * a returning user's existing name can't produce "Sam (iPhone) (Mac)".
 */
export function accountDisplayName(typedName, ua, hints) {
  const base = String(typedName || '').trim();
  if (!base) return '';
  if (/\([^)]+\)\s*$/.test(base)) return base;
  const dev = deviceLabel(ua, hints);
  if (!dev || dev === UNKNOWN) return base;
  return `${base} (${dev})`;
}

/** The device half of "Sam Rivera (iPhone)", or '' when there isn't one. */
export function deviceFromDisplayName(name) {
  const m = /\(([^)]+)\)\s*$/.exec(String(name || ''));
  return m ? m[1].trim() : '';
}

/** Live values for the current browser, using UA-CH hints when present. */
export function currentDevice() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = nav?.userAgent || '';
  const hints = nav?.userAgentData
    ? { platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile }
    : null;
  return {
    device: deviceLabel(ua, hints),
    browser: browserLabel(ua),
    deviceName: deviceDisplayName(ua, hints),
  };
}
