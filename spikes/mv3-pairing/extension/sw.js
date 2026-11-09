// Every network call runs here, in the service worker, as the real extension will. `fetch` is called as a bare global:
// storing it and calling it as a method throws "Illegal invocation" in Chrome.
const routes = { pair: "/public/part-requests/pair", ping: "/public/part-requests/ping" };

async function post(base, route, body, key) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const response = await fetch(`${base}${routes[route]}`, { method: "POST", headers, body: JSON.stringify(body) });
    let json = null;
    try { json = await response.json(); } catch { /* A non-JSON answer stays null. */ }
    return { reached: true, status: response.status, body: json, cors: response.headers.get("access-control-allow-origin") };
  } catch (error) {
    // Chrome reports a CORS or permission refusal only as a TypeError, with no status.
    return { reached: false, error: `${error.name}: ${error.message}` };
  }
}

async function handle(message) {
  if (message.type === "pair") {
    const result = await post(message.base, "pair", { pin: message.pin });
    if (result.reached && result.status === 201) await chrome.storage.local.set({ pairing: { base: message.base, deviceKey: result.body.deviceKey, memberName: result.body.memberName } });
    return result.reached && result.body?.deviceKey ? { ...result, body: { ...result.body, deviceKey: "(stored)" } } : result;
  }
  if (message.type === "ping") {
    const { pairing } = await chrome.storage.local.get("pairing");
    if (!pairing) return { reached: false, error: "not paired" };
    return post(message.base ?? pairing.base, "ping", { echo: message.echo }, message.key ?? pairing.deviceKey);
  }
  if (message.type === "contains") return { granted: await chrome.permissions.contains({ origins: [`${message.origin}/*`] }) };
  if (message.type === "remove") return { removed: await chrome.permissions.remove({ origins: [`${message.origin}/*`] }) };
  if (message.type === "request") {
    // Called without a user gesture on purpose: Chrome must refuse this. The wait lets any gesture passed by the message lapse.
    await new Promise((done) => setTimeout(done, 200));
    try { return { granted: await chrome.permissions.request({ origins: [`${message.origin}/*`] }) }; }
    catch (error) { return { error: `${error.name}: ${error.message}` }; }
  }
  if (message.type === "key") return { deviceKey: (await chrome.storage.local.get("pairing")).pairing?.deviceKey ?? null };
  if (message.type === "forget") { await chrome.storage.local.remove("pairing"); return { ok: true }; }
  return { error: "unknown message" };
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  handle(message).then(reply, (error) => reply({ error: String(error) }));
  return true;
});
