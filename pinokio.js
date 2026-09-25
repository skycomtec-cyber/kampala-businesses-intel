module.exports = {
  version: "7.0",
  title: "Kampala Intelligence Platform",
  description: "A reference directory of Kampala and surrounding businesses, and the demand engine that shows where the gaps are.",
  icon: "icon.png",
  menu: async (kernel, info) => {
    // Dependencies, not the folder: `app` is part of the launcher and is always
    // here, so its presence says nothing about whether it can run.
    let installed = info.exists("app/node_modules/fastify")
    let running = {
      install: info.running("install.js"),
      start: info.running("start.js"),
      update: info.running("update.js"),
      reset: info.running("reset.js"),
      admin: info.running("create-admin.js"),
    }

    if (running.install) {
      return [{
        default: true,
        icon: "fa-solid fa-plug",
        text: "Installing",
        href: "install.js",
      }]
    }
    if (running.update) {
      return [{
        default: true,
        icon: "fa-solid fa-plug",
        text: "Updating",
        href: "update.js",
      }]
    }
    if (running.reset) {
      return [{
        default: true,
        icon: "fa-solid fa-plug",
        text: "Resetting",
        href: "reset.js",
      }]
    }
    if (running.admin) {
      return [{
        default: true,
        icon: "fa-solid fa-terminal",
        text: "Creating Account",
        href: "create-admin.js",
      }]
    }
    if (!installed) {
      return [{
        default: true,
        icon: "fa-solid fa-plug",
        text: "Install",
        href: "install.js",
      }]
    }
    if (running.start) {
      let local = info.local("start.js")
      let url = local && local.url
      let menu = []
      if (url) {
        menu.push({
          default: true,
          icon: "fa-solid fa-rocket",
          text: "Open Web UI",
          href: url,
        })
      }
      menu.push({
        // Default until there is a URL to open, so the menu is never left with
        // nothing selected during the seconds the server takes to come up.
        default: !url,
        icon: "fa-solid fa-terminal",
        text: url ? "Server Terminal" : "Starting",
        href: "start.js",
      }, {
        icon: "fa-solid fa-user-plus",
        text: "<div><strong>Create Admin Account</strong><div>There is no public sign-up</div></div>",
        href: "create-admin.js",
      })
      return menu
    }

    return [{
      default: true,
      icon: "fa-solid fa-power-off",
      text: "Start",
      href: "start.js",
    }, {
      icon: "fa-solid fa-user-plus",
      text: "<div><strong>Create Admin Account</strong><div>There is no public sign-up</div></div>",
      href: "create-admin.js",
    }, {
      icon: "fa-solid fa-plug",
      text: "Update",
      href: "update.js",
    }, {
      icon: "fa-regular fa-circle-xmark",
      text: "<div><strong>Reset</strong><div>Deletes the database and every dependency</div></div>",
      href: "reset.js",
      confirm: "This deletes the database, every operator account and every listing. Are you sure?"
    }]
  }
}
