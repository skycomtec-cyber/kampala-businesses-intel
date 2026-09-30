/**
 * A line reader for interactive commands, which can hide what it is reading.
 *
 * This reads the terminal directly rather than going through readline, because
 * readline has no echo control and reaching for its private `_writeToOutput` to
 * fake one only works when readline happens to route the prompt through it.
 * Under a JavaScript PTY - which is what Pinokio's browser terminals are - the
 * line refresh is swallowed by the echo muter and never comes back out. The
 * prompt then looks frozen while the process waits for input the person
 * reasonably believes was already typed, so whatever they were creating is
 * never created and there is nothing to tell them about it.
 *
 * Raw mode puts echoing in our hands, which also means the keypress handling is
 * ours: both CR and LF end a line, because a PTY bridge may send either, and
 * that asymmetry is exactly what stranded the prompt.
 *
 * The streams are parameters so a test can drive this with a stand-in terminal
 * instead of needing a real one, which is the only way the failing key is
 * reachable.
 */
import { PassThrough } from 'node:stream'

/** A writable that keeps whatever was drawn, so echo can be asserted on. */
export function recorder() {
  const chunks = []
  return {
    write(text) {
      chunks.push(text)
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

/** A readable that presents as a terminal, for driving the reader in a test. */
export function fakeTerminal() {
  const stream = new PassThrough()
  stream.isTTY = true
  let raw = null
  stream.setRawMode = (value) => {
    raw = value
  }
  stream.rawMode = () => raw
  return stream
}

export function createReader(input = process.stdin, output = process.stdout) {
  const canRaw = typeof input.setRawMode === 'function'

  function ask(question, { hidden = false } = {}) {
    return new Promise((resolve, reject) => {
      let value = ''
      let settled = false

      if (canRaw) input.setRawMode(true)
      input.resume()
      output.write(question)

      function finish(result, error) {
        if (settled) return
        settled = true
        input.removeListener('data', onData)
        if (canRaw) input.setRawMode(false)
        input.pause()
        if (error) reject(error)
        else resolve(result)
      }

      function onData(chunk) {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            output.write('\n')
            finish(value)
            return
          }
          // Ctrl+C abandons rather than storing a password nobody meant to type,
          // and Ctrl+D accepts what has been typed so far.
          if (char === '\u0003') {
            output.write('\n')
            finish(null, new Error('Cancelled.'))
            return
          }
          if (char === '\u0004') {
            output.write('\n')
            finish(value)
            return
          }
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1)
              if (!hidden) output.write('\b \b')
            }
            continue
          }
          // Any other control character is not part of the answer.
          if (char < ' ') continue
          value += char
          if (!hidden) output.write(char)
        }
      }

      input.on('data', onData)
    })
  }

  return {
    ask,
    close() {
      input.pause()
      if (canRaw) input.setRawMode(false)
    },
  }
}
