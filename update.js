module.exports = {
  run: [
    {
      // There is no upstream repository to pull: the engine ships inside this
      // launcher, so an update is the same dependency install an update script
      // performs for every other Node app, plus a migration for the new schema.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm install",
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm run bootstrap",
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm run maintenance -- --days 7",
          "npm test",
        ]
      }
    }
  ]
}
