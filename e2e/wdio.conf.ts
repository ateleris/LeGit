// WebdriverIO -> tauri-driver (:4444) -> WebKitWebDriver -> debug binary.
//
// tauri-driver is spawned once for the whole run with HOME/XDG_* pointed at
// E2E_HOME; the app inherits that env, so its data dir (global-settings.json,
// repo settings) and git's global config lookup are fully hermetic.
// Each spec file runs in its own worker session (fresh app launch);
// beforeSession seeds the app data dir for the spec about to run.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { E2E_HOME, SCREENSHOT_DIR, seedForSpec } from "./fixtures.ts";

const APP_BINARY = path.resolve(import.meta.dirname, "../src-tauri/target/debug/legit-app");

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.spec.ts"],
  // One app instance at a time; spec files run sequentially, each in a fresh session.
  maxInstances: 1,
  capabilities: [
    {
      "wdio:maxInstances": 1,
      // tauri-driver's vendor capability: which binary to launch.
      // @ts-expect-error not in wdio's standard capability types
      "tauri:options": { application: APP_BINARY },
    },
  ],
  logLevel: "warn",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  reporters: ["spec"],
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,

  onPrepare: () => {
    rmSync(E2E_HOME, { recursive: true, force: true });
    mkdirSync(E2E_HOME, { recursive: true });
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    tauriDriver = spawn("tauri-driver", [], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        HOME: E2E_HOME,
        XDG_DATA_HOME: path.join(E2E_HOME, ".local", "share"),
        XDG_CONFIG_HOME: path.join(E2E_HOME, ".config"),
        XDG_CACHE_HOME: path.join(E2E_HOME, ".cache"),
      },
    });
    tauriDriver.on("error", (err) => {
      console.error("failed to start tauri-driver:", err);
      process.exit(1);
    });
  },

  onComplete: () => {
    tauriDriver?.kill();
  },

  // Runs in the worker before the session (= before the app launches):
  // regenerate the fixture repo and point global-settings.json at it.
  beforeSession: (_config, _capabilities, specs) => {
    seedForSpec(specs[0]);
  },

  afterTest: async (test, _context, { passed }) => {
    if (!passed) {
      const name = `${test.parent} - ${test.title}`.replace(/[^a-z0-9.-]+/gi, "_");
      await browser.saveScreenshot(path.join(SCREENSHOT_DIR, `${name}.png`));
    }
  },
};
