module.exports = {
  // "Create Admin Account" runs the app's own CLI, which creates one operator
  // account. There is no public registration in this platform, so this is the
  // only way an account is ever created.
  //
  // The credentials are collected with Pinokio's `input` API rather than by
  // handing the terminal to the CLI. The interactive prompt did not survive this
  // shell: the command's trailing newline (and, under Windows, the old
  // cmd.exe -> npm -> node relay) reached the CLI's stdin before the operator
  // could type, so both answers arrived empty and the process exited while the
  // operator was still typing, leaving their keystrokes to land in the shell.
  // Collecting the answers up front and passing them through the environment
  // sidesteps stdin entirely.
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
            description: "At least 12 characters.",
            required: true
          }
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        // The CLI takes the email from --email and the password from the
        // environment, so neither is ever visible in the process table or in
        // shell history. Passed by reference, not interpolated into the command.
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
