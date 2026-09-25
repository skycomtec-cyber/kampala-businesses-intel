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
    }
  ]
}
