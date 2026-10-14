module.exports = {
  // "Change Admin Password" runs the app's own CLI, which resets the password of
  // one existing account. It is the browser-free counterpart to the password
  // reset link: no current password is needed, which is the whole point when the
  // operator has lost the old one.
  //
  // The email, the new password and the repeat are collected in one modal. Both
  // password fields are masked and are handed to the CLI through the environment
  // (KIP_ADMIN_PASSWORD / KIP_ADMIN_PASSWORD_CONFIRM), never on the command line.
  // The CLI refuses to change anything if the two do not match.
  run: [
    {
      method: "input",
      params: {
        title: "Change an operator password",
        description: "Set a new password for an existing account. The old one is not needed.",
        form: [
          {
            type: "email",
            key: "email",
            title: "Email",
            description: "The account whose password is being changed.",
            placeholder: "you@example.com",
            required: true
          },
          {
            type: "password",
            key: "password",
            title: "New password",
            description: "At least 12 characters. Keep it somewhere safe.",
            required: true
          },
          {
            type: "password",
            key: "confirm",
            title: "Repeat new password",
            description: "Type the same password again. Nothing changes if they differ.",
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
          KIP_ADMIN_PASSWORD: "{{input.password}}",
          KIP_ADMIN_PASSWORD_CONFIRM: "{{input.confirm}}"
        },
        message: [
          "node scripts/set-password.js"
        ]
      }
    }
  ]
}
