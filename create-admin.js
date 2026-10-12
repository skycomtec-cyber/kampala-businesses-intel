module.exports = {
  // "Create Admin Account" runs the app's own CLI, which creates one operator
  // account. There is no public registration in this platform, so this is the
  // only way an account is ever created.
  //
  // Collect email via input; collect password via a secure shell prompt so that
  // the password never appears in Pinokio's event/input logs.
  run: [
    {
      method: "input",
      params: {
        title: "Create an operator account",
        description: "There is no public sign-up. This is the only way an account is created.",
        form: [
          {
            type: "email",
            key: "email",
            title: "Email",
            description: "The address the operator will sign in with.",
            placeholder: "you@example.com",
            required: true
          }
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        env: {
          KIP_ADMIN_EMAIL: "{{input.email}}"
        },
        message: [
          "node scripts/create-admin.js"
        ]
      }
    }
  ]
}
