// Applies the saved theme and language before first paint to avoid a flash. A file of its own, not an inline
// script, so the Content-Security-Policy can forbid inline scripts.
try {
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) localStorage.setItem("hd.theme", q.get("theme"));
  if (q.get("lang")) localStorage.setItem("hd.lang", q.get("lang"));
  const t = localStorage.getItem("hd.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  const l = localStorage.getItem("hd.lang");
  if (l) document.documentElement.lang = l;
} catch {}
