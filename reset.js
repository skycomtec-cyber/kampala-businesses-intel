module.exports = {
  run: [
    {
      // Back to pre-install state: no dependencies, no database, no session
      // secret. The source in `app` is part of the launcher rather than a clone,
      // so it stays.
      method: "fs.rm",
      params: {
        path: "app/node_modules"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "app/data"
      }
    },
    {
      // The demonstration database too, at the launcher root rather than under
      // `app`. It is regenerable - `demo.js` rebuilds it on the next run, because
      // that step is conditional on the file being absent - so leaving it behind
      // would be worse than useless: Reset would report the install as cleared
      // while a full set of invented traders survived in a directory nobody
      // remembers creating.
      method: "fs.rm",
      params: {
        path: "data-demo"
      }
    }
  ]
}
