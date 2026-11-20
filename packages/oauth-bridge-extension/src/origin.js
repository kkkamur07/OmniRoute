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
