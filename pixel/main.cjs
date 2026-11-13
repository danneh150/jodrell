// Runs inside Pixel's runtime: shows the jodrell web UI in the terminal pane.
// Started by "jodrell open". Ctrl+C or q closes it.
const { createRoot } = require("@zenbu-labs/pixel");

const url = process.argv[2] || "http://localhost:4545";

const root = createRoot({
  name: "jodrell",
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
  onUnsupportedTerminal() {
    return `This terminal can't show graphics. Open ${url} in a browser, or run "jodrell watch" for the text view.\n`;
  },
});

const page = root.loadURL(url + "?embed=terminal");
page.onChange((state) => root.setTitle(state.title || "jodrell"));
