module.exports = {
  run: [
    {
      // No AI bundle: this is a Node service on SQLite with no model to run, and
      // declaring the bundle would make Pinokio install CUDA for nothing.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm install",
        ]
      }
    },
    {
      // Migrations, reference data, and the message about the first operator
      // account. Idempotent, so a half-finished install repairs itself.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm run bootstrap",
        ]
      }
    },
    {
      // Proves the install rather than asserting it. The suite is small, needs
      // no network, and writes only to temporary folders.
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm test",
        ]
      }
    },
    {
      method: "notify",
      params: {
        title: "Kampala Intelligence Platform installed",
        description:
          "Start the server from the menu, then use \"Create Admin Account\" to add the first operator. " +
          "No business listings are seeded: the platform ships with reference data only.",
      }
    }
  ]
}
