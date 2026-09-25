// Builds a release's updater manifest (latest.json) from its uploaded
// installers + .sig files and replaces it on the release.
//
//   GITHUB_TOKEN=.. GITHUB_REPOSITORY=owner/repo node scripts/updater-json.mjs <release-id> [--dry-run]
//
// --dry-run prints instead of uploading; it needs no token for a published release.

import { fileURLToPath } from "node:url";

// A key missing from the manifest strands that platform's users on the old version.
export const EXPECTED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-aarch64-app",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
];

const ARCH = { x64: "x86_64", amd64: "x86_64", x86_64: "x86_64", aarch64: "aarch64", arm64: "aarch64" };

// Bare `<os>-<arch>` keys follow tauri-action: MSI over NSIS, AppImage for Linux.
const BUNDLES = [
  { re: /_(aarch64|x64)\.app\.tar\.gz$/, keys: (a) => [`darwin-${a}`, `darwin-${a}-app`] },
  { re: /_(amd64|aarch64)\.AppImage$/, keys: (a) => [`linux-${a}`, `linux-${a}-appimage`] },
  { re: /_(amd64|arm64)\.deb$/, keys: (a) => [`linux-${a}-deb`] },
  { re: /\.(x86_64|aarch64)\.rpm$/, keys: (a) => [`linux-${a}-rpm`] },
  { re: /_(x64|arm64)_[^_]+\.msi$/, keys: (a) => [`windows-${a}`, `windows-${a}-msi`] },
  { re: /_(x64|arm64)-setup\.exe$/, keys: (a) => [`windows-${a}-nsis`] },
];

/**
 * @param {{ version: string, notes: string, pubDate: string, apiBase: string,
 *   assets: { id: number, name: string }[], signatures: Record<string, string> }} input
 *   `signatures` maps an installer's asset name to the contents of its `.sig`.
 */
export function buildUpdaterJson({ version, notes, pubDate, apiBase, assets, signatures }) {
  const platforms = {};
  for (const asset of assets) {
    const bundle = BUNDLES.find((b) => b.re.test(asset.name));
    if (!bundle) continue;
    const signature = signatures[asset.name];
    if (!signature) throw new Error(`${asset.name} has no ${asset.name}.sig on the release`);
    const arch = ARCH[bundle.re.exec(asset.name)[1]];
    for (const key of bundle.keys(arch)) {
      if (platforms[key]) throw new Error(`${key} is served by both ${platforms[key].asset} and ${asset.name}`);
      platforms[key] = { signature: signature.trim(), url: `${apiBase}/releases/assets/${asset.id}`, asset: asset.name };
    }
  }
  const missing = EXPECTED_PLATFORMS.filter((k) => !platforms[k]);
  if (missing.length) throw new Error(`release lacks installers for: ${missing.join(", ")}`);

  const sorted = Object.fromEntries(
    Object.keys(platforms)
      .sort()
      .map((k) => [k, { signature: platforms[k].signature, url: platforms[k].url }]),
  );
  return { version, notes, pub_date: pubDate, platforms: sorted };
}

async function gh(url, { token, accept = "application/vnd.github+json", ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      accept,
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return res;
}

async function main() {
  const [releaseId, flag] = process.argv.slice(2);
  const dryRun = flag === "--dry-run";
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!releaseId || !repo || (!token && !dryRun)) {
    throw new Error("usage: GITHUB_TOKEN=.. GITHUB_REPOSITORY=owner/repo node scripts/updater-json.mjs <release-id> [--dry-run]");
  }
  const apiBase = `https://api.github.com/repos/${repo}`;

  const release = await (await gh(`${apiBase}/releases/${releaseId}`, { token })).json();
  const signatures = {};
  for (const sig of release.assets.filter((a) => a.name.endsWith(".sig"))) {
    const res = await gh(`${apiBase}/releases/assets/${sig.id}`, { token, accept: "application/octet-stream" });
    signatures[sig.name.slice(0, -".sig".length)] = await res.text();
  }

  const manifest = buildUpdaterJson({
    version: release.tag_name.replace(/^v/, ""),
    notes: (release.body ?? "").replace(/\r\n/g, "\n"),
    pubDate: new Date().toISOString(),
    apiBase,
    assets: release.assets,
    signatures,
  });
  const body = JSON.stringify(manifest, null, 2);
  if (dryRun) {
    console.log(body);
    return;
  }

  const existing = release.assets.find((a) => a.name === "latest.json");
  if (existing) await gh(`${apiBase}/releases/assets/${existing.id}`, { token, method: "DELETE" });
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, "") + "?name=latest.json";
  await gh(uploadUrl, { token, method: "POST", headers: { "content-type": "application/json" }, body });
  console.log(`latest.json uploaded: ${Object.keys(manifest.platforms).join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
