/*
 * The behaviour behind the boxes theme.css draws.
 *
 * One <dialog> element, built once and reused, so opening a box is not a
 * promise to a garbage collector. Everything a modal owes its user -- the focus
 * trap, Escape, the inert page behind it -- comes from the element; what is
 * left here is the three decisions the element cannot make for us.
 *
 * 1. Which way round the buttons are, and which one is focused first. The
 *    default focus lands on the least destructive choice, because a box that
 *    opens with its dangerous button under the operator's finger has already
 *    caused the accident it was meant to prevent. For a box that only reports,
 *    focus goes to the one button, because there is nothing to be careful of.
 * 2. What a click outside the box means. It means go back. The browser has no
 *    opinion, and a box that cannot be dismissed by clicking the page around it
 *    reads as a dead end on a trackpad.
 * 3. What the caller is told: a promise that resolves true only if the operator
 *    pressed the button that commits. Escape and the backdrop both resolve
 *    false, so a caller cannot mistake "dismissed" for "confirmed".
 *
 * Colours are not decided here. The tone is passed in and theme.css gives it
 * the signal colour the rest of the file already uses for that meaning, so this
 * file never learns what "danger" looks like.
 */

const TONES = {
  // The glyph is not decoration. It is the cue that survives a reader who
  // cannot separate the hues, and it is paired with the wording in every case.
  neutral: 'i',
  success: '✓',
  warning: '!',
  danger: '×',
}

let element = null
let retire = null
// Close events this component caused itself and must not answer. See open().
let owed = 0

/**
 * Builds the dialog once. Everything inside it is replaced per call, because
 * the body of a box is caller data and caller data does not get to be markup
 * here: the same rule operator.html follows with text from a survey file.
 */
function build() {
  if (element) return element

  element = document.createElement('dialog')
  element.className = 'sheet'
  element.innerHTML = `
    <div class="sheet-head">
      <span class="sheet-mark" aria-hidden="true"></span>
      <h2 class="sheet-title"></h2>
    </div>
    <div class="sheet-body"></div>
    <form method="dialog" class="sheet-actions">
      <button type="submit" value="cancel" class="quiet"></button>
      <button type="submit" value="confirm" class="tone-primary"></button>
    </form>
  `

  // A click on the backdrop reports the dialog itself as its target, because
  // every visible pixel inside the box belongs to a child. That is what makes
  // this one line correct rather than a guess.
  element.addEventListener('click', (event) => {
    if (event.target === element) element.close('cancel')
  })

  // Attached here, once, and only now that its listeners are in place.
  // showModal() throws InvalidStateError on a dialog that is not in a document,
  // and building it detached meant every open() threw before a box was ever
  // shown. The node is held by this module for as long as the page lives, so
  // one append is the only one this component ever needs.
  document.body.append(element)

  return element
}

function part(selector) {
  return element.querySelector(selector)
}

/**
 * Opens a box and resolves once it is gone.
 *
 * @param {object} options
 * @param {'neutral'|'success'|'warning'|'danger'} [options.tone]
 * @param {string} options.title             what the box is about
 * @param {string|Node} [options.body]       the sentence, and anything under it
 * @param {Array<[string, string]>} [options.facts]  label/value pairs, as a record
 * @param {string} [options.confirm]         label for the committing button
 * @param {string} [options.cancel]          label for the way back; omit for a box
 *                                           that only reports
 * @returns {Promise<boolean>} true only if the committing button was pressed
 */
function open(options = {}) {
  const tone = TONES[options.tone] ? options.tone : 'neutral'
  const box = build()

  // A second box over the first would leave the first promise unresolved
  // forever, so the older one is closed as a dismissal.
  //
  // The dismissal is a close() we call, and close is delivered as a task rather
  // than synchronously. So the event it raises arrives *after* this call has
  // attached its own listener, and the new box answers the old box's exit: it
  // resolves false the moment it appears, and the button in it then does nothing
  // for the rest of the page's life. Retiring the old listener does not help,
  // because the event is not addressed to it -- it goes to whoever is listening
  // by the time it lands.
  //
  // So each close we cause is counted, and the listener spends the count instead
  // of settling on it. The count also covers the case where the box was already
  // on its way out when we got here -- an Escape, say -- and its event is still
  // in the queue with nothing left listening to explain where it came from.
  const superseded = retire !== null
  if (retire) retire()
  retire = null
  if (box.open) {
    box.close('cancel')
    owed += 1
  } else if (superseded) {
    owed += 1
  }

  box.dataset.tone = tone
  part('.sheet-mark').textContent = TONES[tone]
  part('.sheet-title').textContent = options.title ?? ''

  const body = part('.sheet-body')
  body.replaceChildren()
  if (options.body) {
    if (typeof options.body === 'string') {
      const paragraph = document.createElement('p')
      paragraph.textContent = options.body
      body.append(paragraph)
    } else {
      body.append(options.body)
    }
  }
  if (options.facts?.length) {
    const list = document.createElement('dl')
    list.className = 'facts'
    for (const [label, value] of options.facts) {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = value
      list.append(term, detail)
    }
    body.append(list)
  }

  // A box that only reports gets one button and no way back, because there is
  // nothing to go back from.
  const confirm = part('button[value="confirm"]')
  const cancel = part('button[value="cancel"]')
  if (options.confirm) {
    confirm.textContent = options.confirm
    confirm.hidden = false
  } else {
    confirm.hidden = true
  }
  if (options.cancel) {
    cancel.textContent = options.cancel
    cancel.hidden = false
  } else {
    cancel.hidden = true
  }

  // The form's method is "dialog", so both buttons and Escape set returnValue
  // and fire close. Escape leaves it empty, which is not 'confirm', so the
  // default is the safe answer rather than the intended one.
  //
  // The listener belongs to this call alone, and `retire` is the handle the next
  // open() uses to take it off the element again: one box, one waiting caller,
  // and no close event that can settle a promise it does not own.
  //
  // Retiring also answers the call being retired, with the same false that
  // Escape and the backdrop give. Unhooking alone would leave its promise
  // pending forever, which is the exact outcome the dismissal above exists to
  // prevent, and a caller awaiting the older box would wait on it for good.
  const result = new Promise((resolve) => {
    const onClose = () => {
      if (owed > 0) {
        owed -= 1
        return
      }
      if (retire === teardown) retire = null
      resolve(box.returnValue === 'confirm')
    }
    const teardown = () => {
      retire = null
      box.removeEventListener('close', onClose)
      resolve(false)
    }
    retire = teardown
    box.addEventListener('close', onClose)
  })

  box.showModal()
  // showModal focuses the first focusable descendant, which is the way back
  // button whenever there is one, and that is the order the two are written in
  // anyway. Naming it says the intent rather than relying on document order.
  ;(cancel.hidden ? confirm : cancel).focus()

  return result
}

window.kipSheet = { open }
