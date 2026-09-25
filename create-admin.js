module.exports = {
  // "Create Admin Account" runs the app's own CLI, which prompts for the email
  // and hides the password as it is typed. There is no public registration in
  // this platform, so this is the only way an account is ever created.
  run: [
    {
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm run create-admin",
        ]
      }
    }
  ]
}
