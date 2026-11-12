// Opens a library's pages in its own colour straight away, before the app
// has loaded (the app remembers it: src/client/lib/theme.ts). An external
// file, since the site's security policy allows no inline scripts.
(() => {
  try {
    const slug = location.pathname.split("/")[1];
    const theme = slug && localStorage.getItem(`theme:${slug}`);
    if (theme && /^[a-z]{3,10}$/.test(theme) && theme !== "green") {
      document.documentElement.dataset.accent = theme;
    }
  } catch {
    // Storage blocked: the colour arrives with the page.
  }
})();
