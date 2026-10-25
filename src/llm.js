// Shared transport for the manager's AI helpers (port scan,
// project analysis): one OpenAI-compatible chat completions call
// that must answer with a JSON object. The API key exists only in
// the llm config object (see resolveLlm in config.js) — it is
// sent as the Authorization header and NEVER written to any
// response, log, or file by this module; failures throw short
// messages that contain no key material.
export async function chatJson(llm, messages, { timeoutMs = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: llm.model, temperature: 0, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('request timed out');
    }
    throw new Error(`request failed: ${e && e.message ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const content = data
    && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') throw new Error('unexpected response shape');
  // Tolerate code fences / prose around the JSON object.
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('response was not JSON');
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error('response was not JSON');
  }
}
