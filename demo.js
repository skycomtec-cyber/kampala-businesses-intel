module.exports = {
  // The server outlives this script, so the script has to stay alive too.
  daemon: true,
  run: [
    {
      // Build the demonstration database, but only the first time.
      //
      // seed-demo.js refuses to run against a directory that already holds
      // businesses, which is correct and which makes this step's guard necessary:
      // without the `when`, the second launch of the demonstration would fail on
      // its own dataset and the menu would show a refusal instead of a server.
      //
      // So the seeding is conditional on the file not being there, and the
      // demonstration is built once per reset. Delete `data-demo` (or use Reset) to
      // rebuild it from scratch.
      when: "{{!exists('data-demo/kampala.db')}}",
      method: "shell.run",
      params: {
        path: "app",
        env: {
          // Absolute, from the launcher's own folder, rather than a relative
          // `../data-demo`. The shell runs in `app` but `{{cwd}}` is the launcher
          // root, and a relative path here would depend on which directory npm
          // happened to start in.
          KIP_DATA_DIR: "{{cwd}}/data-demo",
          // The one account the demonstration can be signed into. The password is
          // generated and printed by the seeder rather than set here, so there is
          // no well-known credential in a file.
          KIP_DEMO_ADMIN_EMAIL: "demo@kampala.local",
        },
        // Not best-effort, unlike the maintenance step in start.js. This one is the
        // demonstration: if it fails there is nothing to serve, and a server that
        // comes up against an empty directory would show a blank platform and look
        // like a working one.
        message: ["npm run seed:demo"]
      }
    },
    {
      id: "start",
      method: "shell.run",
      params: {
        path: "app",
        env: {
          // Never 0.0.0.0, same as start.js. The demonstration holds a database
          // and an operator session store.
          KIP_HOST: "127.0.0.1",
          // The next free port, so the demonstration and the real install can run
          // side by side. Two copies of this launcher is the normal case here: the
          // point of the demonstration is comparing it against the real thing.
          KIP_PORT: "{{port}}",
          // The whole point: the same server, a different database.
          KIP_DATA_DIR: "{{cwd}}/data-demo",
        },
        message: ["npm start"],
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
