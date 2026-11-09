// The pairing screen. permissions.request must run inside the click, before anything is awaited, or Chrome refuses it.
const $ = (id) => document.getElementById(id);
const show = (value) => { $("result").textContent = JSON.stringify(value); document.body.dataset.done = String(Number(document.body.dataset.done ?? 0) + 1); };

$("pair").addEventListener("click", () => {
  let origin;
  try { origin = new URL($("address").value.trim()).origin; } catch { show({ error: "Enter the site address" }); return; }
  const base = `${origin}${$("prefix").value}`;
  document.body.dataset.prompt = "waiting";
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    document.body.dataset.prompt = granted ? "granted" : "denied";
    if (!granted) { show({ granted }); return; }
    show({ granted, ...await chrome.runtime.sendMessage({ type: "pair", base, pin: $("pin").value }) });
  }, (error) => { document.body.dataset.prompt = "error"; show({ error: String(error) }); });
});
