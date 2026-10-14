module.exports = {
  // "Create Admin Account" runs the app's own CLI, which creates one operator
  // account. There is no public registration in this platform, so this is the
  // only way an account is ever created.
  //
  // Collect the email and the password in one modal. The password is a masked
  // field and is handed to the CLI through the environment (KIP_ADMIN_PASSWORD),
  // never on the command line, so it stays out of the process list. Pinokio's
  // shell has no TTY, so the CLI cannot prompt for the password itself: every
  // answer has to be collected here.
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
          },
          {
            type: "password",
            key: "password",
            title: "Password",
            description: "At least 8 characters. Choose something you will keep safe.",
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
          KIP_ADMIN_EMAIL: "{{input.email}}",
          KIP_ADMIN_PASSWORD: "{{input.password}}"
        },
        message: [
          "node scripts/create-admin.js"
        ]
      }
    }
  ]
}
