/**
 * The only script the marketing pages load. It is a file rather than an inline block
 * so the content policy can refuse inline script outright — a policy with
 * 'unsafe-inline' in it is not refusing much.
 *
 * Without it the form still posts; the browser just navigates to the API's reply,
 * which works and reads badly. Everything here is presentation.
 */
for (const form of document.querySelectorAll('form.waitlist')) {
  const status = form.parentElement.querySelector('.form-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    const email = form.querySelector('input[type=email]').value;
    button.disabled = true;
    status.textContent = form.dataset.sending;
    try {
      const res = await fetch(`${form.action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
        status.textContent = form.dataset.slow;
        button.disabled = false;
      } else {
        status.textContent = form.dataset.bad;
        button.disabled = false;
      }
    } catch {
      status.textContent = form.dataset.offline;
      button.disabled = false;
    }
  });
}
