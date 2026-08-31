"use strict";

const fs = require("fs");
const path = require("path");

const THEMES_DIR = path.resolve(__dirname, "..", "..", "office-design", "assets", "themes");

function hex(value) {
  return String(value || "").replace(/^#/, "").toUpperCase();
}

function loadTheme(name = "business") {
  const file = path.join(THEMES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown Office theme: ${name}`);
  }
  const colors = JSON.parse(fs.readFileSync(file, "utf8")).colors;
  return {
    primary: hex(colors.primary),
    secondary: hex(colors.foreground),
    accent: hex(colors.accent),
    light: hex(colors.surface),
    bg: hex(colors.background),
  };
}

module.exports = { loadTheme };
