module.exports = {
  apps: [{
    name: "oryahchat",
    script: "server.js",
    cwd: "/opt/oryahchat",
    env: {
      SETUP_PASSWORD: "Oryah2026!",
      JWT_SECRET: "52faf6339a67680d60bb4b89faf1f88556628fb46d013309754032b288096786",
      SESSION_HOURS: "72"
    }
  }]
};
