// The release workflow exports the updater signing key into the environment
// of the step that runs `vite build`; Vite inlines every variable matching one
// of its env prefixes into the bundle on a bare `import.meta.env` reference.
// So no prefix may match the signing secrets, or one stray debug line would
// ship the private key inside every public installer.
//
// Lives at the repo root: it belongs to the node tsconfig project, and
// importing vite.config.ts from a src/ test trips TS6305 (the src project
// would need the referenced project's declaration output).

import { test, expect } from "vitest";
import viteConfig from "./vite.config";

const SIGNING_SECRETS = ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];

test("no Vite env prefix matches the release signing secrets", () => {
  const config = viteConfig as { envPrefix?: string | string[] };
  const prefixes = ([] as string[]).concat(config.envPrefix ?? "VITE_");
  for (const secret of SIGNING_SECRETS) {
    const exposedBy = prefixes.filter((p) => secret.startsWith(p));
    expect(exposedBy, `${secret} would be inlined via envPrefix ${JSON.stringify(exposedBy)}`).toEqual([]);
  }
});
