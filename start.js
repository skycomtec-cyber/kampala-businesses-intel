module.exports = {
  // The server outlives this script, so the script has to stay alive too.
  daemon: true,
  run: [
    {
      // The rollup and the retention purge, before the port opens rather than
      // on a timer nobody is running. Without it the public opportunity view
      // would always be empty, because the insights routes only read the rollup.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm run maintenance",
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
