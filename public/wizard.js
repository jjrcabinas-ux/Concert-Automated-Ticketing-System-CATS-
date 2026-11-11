// Turns the ticket form into a 3-step wizard. Without JavaScript the form still works as one long page.
(() => {
  const form = document.querySelector('form.wizard');
  if (!form) return;
  const pages = [...form.querySelectorAll('.pg')];
  const dots = [...form.querySelectorAll('.st')];
  const vp = form.querySelector('.vp');
  const back = form.querySelector('.bk'), next = form.querySelector('.nx'), submit = form.querySelector('.go');
  const err = form.querySelector('.werr'), say = form.querySelector('.vh');
  const sels = [...form.querySelectorAll('select[data-price]')];
  const max = +form.dataset.max || 10;
  const peso = (c) => '₱' + (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const last = pages.length - 1;
  let step = 0;

  form.classList.add('ready');
  form.noValidate = true;   // each step is checked here; the server re-checks everything

  const picked = () => sels.filter((s) => +s.value > 0).map((s) => ({
    name: s.closest('.tier').querySelector('.name').textContent, qty: +s.value, price: +s.dataset.price }));
  const totals = () => picked().reduce((t, l) => ({ qty: t.qty + l.qty, amt: t.amt + l.qty * l.price }), { qty: 0, amt: 0 });

  function updateTotal() {
    form.querySelector('[data-total]').textContent = peso(totals().amt);
    if (step === 0) err.textContent = '';
  }

  function fitHeight() { vp.style.height = pages[step].offsetHeight + 'px'; }

  function fail(msg, field) {
    err.textContent = msg;
    if (field) field.focus();
    return false;
  }

  function valid(n) {
    if (n === 0) {
      const t = totals();
      if (!t.qty) return fail('Please choose at least one ticket.', sels.find((s) => !s.disabled));
      if (t.qty > max) return fail(`Maximum of ${max} tickets per order. You picked ${t.qty}.`);
    }
    if (n === 1) {
      const name = form.buyer_name, mobile = form.mobile, addr = form.address;
      mobile.value = mobile.value.replace(/\D/g, '');
      if (!name.value.trim()) return fail('Please enter your full name.', name);
      if (!/^09\d{9}$/.test(mobile.value)) return fail('Enter an 11-digit mobile number starting with 09.', mobile);
      if (!addr.value.trim()) return fail('Please enter your purok or street address.', addr);
    }
    err.textContent = '';
    return true;
  }

  function fillReview() {
    const t = totals();
    form.querySelector('[data-review]').innerHTML = `<table>
      ${picked().map((l) => `<tr><td>${l.qty} × ${esc(l.name)}</td><td class="num">${peso(l.qty * l.price)}</td></tr>`).join('')}
      <tr class="total"><td>Total (${t.qty} ticket${t.qty > 1 ? 's' : ''})</td><td class="num">${peso(t.amt)}</td></tr></table>
      <p class="who"><strong>${esc(form.buyer_name.value.trim())}</strong> · ${esc(form.mobile.value)} · ${esc(form.address.value.trim())}
      <button type="button" class="link edit" data-go="1">Edit</button></p>`;
  }

  function go(n, focus) {
    step = Math.max(0, Math.min(last, n));
    if (step === last) fillReview();
    form.style.setProperty('--s', step);
    pages.forEach((p, i) => { p.inert = i !== step; });
    dots.forEach((d, i) => {
      d.classList.toggle('on', i === step);
      d.classList.toggle('done', i < step);
      d.disabled = i > step;
    });
    form.toggleAttribute('data-first', step === 0);
    form.toggleAttribute('data-last', step === last);
    fitHeight();
    if (focus) {
      say.textContent = `Step ${step + 1} of ${pages.length}: ${pages[step].querySelector('h2').textContent}`;
      const f = pages[step].querySelector('input:not([type=radio]), select:not(:disabled), input[type=radio]:checked');
      if (f) f.focus({ preventScroll: true });
      const top = form.getBoundingClientRect().top;
      if (top < 0) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Forward only after the current step checks out; backwards always.
  const forward = () => { for (let i = 0; i <= step; i++) if (!valid(i)) return go(i, false); go(step + 1, true); };
  next.addEventListener('click', forward);
  back.addEventListener('click', () => go(step - 1, true));
  form.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t && +t.dataset.go < step) go(+t.dataset.go, true);
  });
  // Place order: the button shrinks to loading dots while the order is sent, turns into a green check,
  // then moves to the order (or payment) page. Enter in a text box on earlier steps just goes to the next step.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnState = (s) => { submit.dataset.s = s; submit.setAttribute('aria-busy', s === 'load'); };
  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (step < last) return forward();
    for (let i = 0; i < last; i++) if (!valid(i)) return go(i, false);
    if (sending) return;
    sending = true; err.textContent = ''; btnState('load'); say.textContent = 'Placing your order';
    const started = Date.now();
    try {
      const res = await fetch(form.action, {
        method: 'POST', body: new URLSearchParams(new FormData(form)),
        headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      await sleep(Math.max(0, 900 - (Date.now() - started)));      // let the dots play briefly
      if (!res.ok || !data.redirect) throw new Error(data.error || 'Something went wrong. Please try again.');
      btnState('done'); say.textContent = 'Order placed';
      await sleep(900);
      location.assign(data.redirect);
    } catch (ex) {
      btnState('idle'); sending = false;
      err.textContent = ex.message === 'Failed to fetch' ? 'No connection. Check your internet and try again.' : ex.message;
      say.textContent = err.textContent;
    }
  });
  sels.forEach((s) => s.addEventListener('change', updateTotal));
  if ('ResizeObserver' in window) new ResizeObserver(fitHeight).observe(form.querySelector('.tr'));
  window.addEventListener('resize', fitHeight);
  // Coming back with the browser's Back button: re-enable the submit button.
  window.addEventListener('pageshow', () => { btnState('idle'); sending = false; });

  updateTotal();
  go(0, false);
})();
