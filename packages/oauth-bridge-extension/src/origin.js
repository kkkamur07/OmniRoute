/**
 * Origin of an http(s) tab, or null. Chrome omits tab.url unless the extension has activeTab
 * (on icon click) or a host permission, and non-web pages (chrome://, file:) are not dashboards.
 * @param {{ url?: string } | null | undefined} tab
 * @returns {string | null}
 */
export function tabOrigin(tab) {
  const raw = tab && typeof tab.url === "string" ? tab.url : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

const MAX_ORIGIN_LENGTH = 256;

/**
 * The dashboard origin the approve page was opened for: the `origin` query parameter of
 * `search` (for example location.search), or null. Only a bare http(s) origin such as
 * `https://host:port` is accepted: no path, query, fragment, credentials or other scheme.
 * @param {string} search
 * @returns {string | null}
 */
export function approveOriginFromSearch(search) {
  if (typeof search !== "string") return null;
  const raw = new URLSearchParams(search).get("origin");
  if (!raw || raw.length > MAX_ORIGIN_LENGTH) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // url.origin drops any path, query or fragment, so equality rejects them (and a trailing "/").
  return url.origin === raw ? raw : null;
}
