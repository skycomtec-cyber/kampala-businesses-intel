/*
 * Two jobs, both small on purpose.
 *
 * 1. Put the saved colour choice on <html> before first paint, so a dark-mode
 *    visitor never gets a white flash. The inline snippet in each page's <head>
 *    does the reading; this file handles the button.
 * 2. Toggle light/dark and remember it.
 *
 * The rest of the interface still works with JavaScript switched off: this only
 * ever changes which tokens are in force.
 */

const KEY = 'kip-theme'

function current() {
  return (
    document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )
}

function paint(theme) {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.setAttribute('aria-pressed', String(theme === 'dark'))
    button.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance',
    )
  }
}

function wire() {
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.hidden = false
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(KEY, next)
      } catch {
        // Private browsing can refuse storage. The toggle still works for this
        // page view, it just will not be remembered.
      }
      paint(next)
    })
  }
  paint(document.documentElement.getAttribute('data-theme') || undefined)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire)
} else {
  wire()
}
