module.exports = {
  // The server outlives this script, so the script has to stay alive too.
  daemon: true,
  run: [
    {
      // The rollup and the retention purge, before the port opens rather than
      // on a timer nobody is running. Without it the public opportunity view
      // would always be empty, because the insights routes only read the rollup.
      //
      // Best effort on purpose. maintenance.js is a retention safety net, not a
      // launch requirement, but it reports failures on stderr (maintenance.js
      // writes "Maintenance failed: ...", and npm adds its own "error:" lines on
      // top). Pinokio's only documented way to stop a step is an error pattern
      // match, and `/Error:/` is on by default, so those lines would blue-screen
      // this step and the server would never bind at all. A bad rollup day or a
      // locked database file would turn a stale rollup into no app.
      //
      // So stderr is dropped rather than inspected, and the exit code is
      // restated as a plain line the log keeps. That trades the reason for the
      // failure for a launch that always happens, which is the right way round:
      // maintenance.js already documents that retention happens whether or not
      // anyone runs it. No `on` handler is attached, so the step still ends on
      // the shell prompt exactly as it did before.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          // `2>nul` and `2>/dev/null` are the two spellings of /dev/null.
          // `||` and `echo` are built into both cmd.exe and bash, so the
          // fallback needs no extra tooling.
          //
          // The trailing `cd .` is Windows-only and exists because of a cmd.exe
          // quirk: `echo` succeeds but does NOT reset ERRORLEVEL, so `||` alone
          // still leaves the step exiting non-zero. `&` binds looser than `||`,
          // so this runs on both paths and prints nothing. bash has no such
          // quirk -- `||` already yields 0 there.
          "{{platform === 'win32' ? 'npm run maintenance 2>nul' : 'npm run maintenance 2>/dev/null'}} || echo maintenance did not complete, starting anyway{{platform === 'win32' ? ' & cd .' : ''}}",
        ]
      }
    },
    {
      id: "start",
      method: "shell.run",
      params: {
        path: "app",
        env: {
          // Never 0.0.0.0: this process holds a database and an operator session
          // store, and the share features are how it should be exposed if at all.
          KIP_HOST: "127.0.0.1",
          // The next free port, never a hardcoded one, so two copies of this
          // launcher can run side by side.
          KIP_PORT: "{{port}}",
        },
        message: [
          "npm start",
        ],
        on: [{
          // The server prints its own listening line on start, so the URL is
          // read from the output rather than assembled from host and port here.
          "event": "/(http:\\/\\/[0-9.:]+)/",
          "done": true
        }]
      }
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[1]}}"
      }
    },
    {
      method: "proxy.start",
      params: {
        uri: "{{local.url}}",
        name: "Local Sharing"
      }
    }
  ]
}
