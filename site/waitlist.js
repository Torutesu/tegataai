/**
 * The only script the marketing pages load. It is a file rather than an inline block
 * so the content policy can refuse inline script outright — a policy with
 * 'unsafe-inline' in it is not refusing much.
 *
 * Without it the form still posts; the browser just navigates to the API's reply,
 * which works and reads badly. Everything here is presentation.
 *
 * The confirmation is what the person is waiting for, so the time to it is the number
 * that matters, not the time the server spends. Two things used to dominate it and
 * neither was the server:
 *
 *   1. The API is on another origin, and `content-type: application/json` is not a
 *      CORS-safelisted header value, so the browser sent a preflight OPTIONS and waited
 *      for it before sending anything. That is a whole extra round trip in front of the
 *      request, paid on the submission the person actually watches. A JSON body sent as
 *      `text/plain` is a simple request: no preflight. The server parses it either way.
 *   2. Nothing bounded the wait. A connection that hung left "Sending…" on screen
 *      forever, which reads as a broken page rather than a slow one.
 */
const DEADLINE_MS = 8000;

/** Undefined on a browser too old to have it; there the wait is simply unbounded. */
const deadline = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
  ? AbortSignal.timeout(DEADLINE_MS) : undefined);

for (const form of document.querySelectorAll('form.waitlist')) {
  const status = form.parentElement.querySelector('.form-status');
  const input = form.querySelector('input[type=email]');

  // The page preconnects to the API on load, but a browser drops an idle preconnected
  // socket after a few seconds, and someone who reads the page first will be well past
  // that by the time they type. Touching the field is the last moment at which opening
  // the connection is still free, so it is opened again here.
  let warmed = false;
  const warm = () => {
    if (warmed) return;
    warmed = true;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = new URL(form.action).origin;
    link.crossOrigin = '';
    document.head.appendChild(link);
  };
  input.addEventListener('focus', warm, { once: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    const email = input.value;
    button.disabled = true;
    status.textContent = form.dataset.sending;

    const fail = (message) => {
      status.textContent = message;
      button.disabled = false;
    };

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        // Safelisted, so this is a simple request and no preflight precedes it. The
        // body is still JSON and the server still reads it as JSON.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        signal: deadline(),
        body: JSON.stringify({
          email,
          locale: document.documentElement.lang,
          source: 'site',
          company_website: form.querySelector('input[name=company_website]').value,
        }),
      });
      if (res.status === 202) {
        form.hidden = true;
        status.textContent = form.dataset.done;
      } else if (res.status === 429) {
        fail(form.dataset.slow);
      } else {
        fail(form.dataset.bad);
      }
    } catch {
      // A timeout and a dead network are the same sentence to the person reading it:
      // we did not get through, try again.
      fail(form.dataset.offline);
    }
  });
}
