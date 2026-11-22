// Fills support email / phone / WhatsApp from the DoCall API (admins edit them in
// the admin portal → Settings). The values written in the HTML are the fallback,
// so the page still works if the API is unreachable.
(() => {
  const ENDPOINT = 'https://api.docall.coddeitcorp.com/api/v1/system-config/support-contact'

  const formatPhone = (e164) => {
    const m = /^\+91(\d{5})(\d{5})$/.exec(e164)
    return m ? `+91 ${m[1]} ${m[2]}` : e164
  }

  // Links always get the new href; text is replaced only where marked with data-label
  // (on the link itself or a child), so wording like "email us" stays as written.
  const setLabel = (el, text) => {
    const label = el.hasAttribute('data-label') ? el : el.querySelector('[data-label]')
    if (label) label.textContent = text
  }

  const apply = ({ email, phone, whatsapp }) => {
    if (email) {
      document.querySelectorAll('[data-support-email]').forEach((el) => {
        const subject = el.dataset.subject ? `?subject=${encodeURIComponent(el.dataset.subject)}` : ''
        el.href = `mailto:${email}${subject}`
        setLabel(el, email)
      })
    }
    if (phone) {
      document.querySelectorAll('[data-support-phone]').forEach((el) => {
        el.href = `tel:${phone}`
        setLabel(el, formatPhone(phone))
      })
    }
    const wa = whatsapp || phone
    if (wa) {
      document.querySelectorAll('[data-support-whatsapp]').forEach((el) => {
        el.href = `https://wa.me/${wa.replace(/\D/g, '')}`
        setLabel(el, formatPhone(wa))
      })
    }
  }

  fetch(ENDPOINT, { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => { if (body && body.success && body.data) apply(body.data) })
    .catch(() => { /* keep the fallback values */ })
})()
