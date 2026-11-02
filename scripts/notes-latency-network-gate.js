// Evaluation-only prefix, prepended to an isolated copy of the production worker.
// Credentials/headers never leave the worker; only request JSON goes to the budget gate.
(() => {
  const native = globalThis.fetch.bind(globalThis);
  const replies = new Map();
  let serial = 0;
  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'EVALUATION_FETCH_REPLY') return;
    event.stopImmediatePropagation();
    replies.get(event.data.id)?.(event.data.reply);
  });
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://hpop.ai/'))
      throw Error('Unexpected evaluation destination');
    const id = ++serial;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(Error('Evaluation gate timeout'));
      }, 10000);
      replies.set(id, (value) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(value);
      });
      self.postMessage({ type: 'EVALUATION_FETCH', id, body: JSON.parse(String(options.body)) });
    });
    if (!reply.allowed) throw Error('Evaluation budget exhausted');
    if (reply.offline)
      return new Response(reply.body, { headers: { 'content-type': 'text/event-stream' } });
    return native(url, options);
  };
})();
