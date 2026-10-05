# Contributing

Zipper targets Jellyfin Server and Web 12.0.0 with .NET 10. See the [installation guide](docs/installation.md) for the Web integration dependency.

For a bug report, include the affected versions, browser, theme, steps to reproduce, and expected behavior. Use sample titles when possible. Remove server addresses, account details, media paths, tokens, and private library information from logs and screenshots. Follow [SECURITY.md](SECURITY.md) for security reports.

Keep changes focused. Preserve Jellyfin's permissions and native controls, original media and subtitle filenames, streaming resource limits, and other plugins' behavior. A package must contain only the files Jellyfin associates with the selected media source. Do not add directory scans or rename subtitle tracks to reconstruct language information.

## Building

Install the .NET 10 SDK and Node.js 24 or newer:

```powershell
dotnet build Zipper.sln --configuration Release
dotnet format Zipper.sln --verify-no-changes
node --check src/Jellyfin.Plugin.Zipper/Web/zipper.js
node --check src/Jellyfin.Plugin.Zipper/Web/zipper.i18n.js
node --check scripts/package.mjs
node scripts/package.mjs --version 1.0.0.0 --output-dir artifacts
```

The installer ZIP is written to `artifacts/`.

## Translations

Interface strings live in `src/Jellyfin.Plugin.Zipper/Web/locales/`. English is the reference catalog; Polish is included. The interface follows Jellyfin's document language, with browser-language fallback when the document has no language, and English fallback for unsupported languages or unavailable strings.

When updating a translation:

1. Keep the English key names and any placeholders, such as `{title}`, `{size}`, or `{count}`.
2. Translate the meaning in the context of the chooser, preferences, Downloads, or administrator settings. Interface language and subtitle language are independent.
3. Keep labels short. A transfer marked **Sent** means the server finished its response; the browser manages download progress and saving.
4. For count strings, use the plural categories required by the language's `Intl.PluralRules`. Polish uses `one`, `few`, `many`, and `other`.
5. Check narrow screens, long titles, keyboard navigation, and both light and dark palettes. Translations are rendered as text; do not add HTML.

Adding a new language also requires registering its locale in `zipper.i18n.js` and the controller's locale allowlist. The project embeds locale JSON files automatically. Include an English fallback wherever a new string is used, and check that both existing catalogs contain the new key.

## Validation

Run the build, formatting, JavaScript syntax, and packaging commands above. Check every changed JavaScript file, including the shared locale loader. Parse the locale catalogs as JSON and verify matching placeholders. Extract the generated installer and check its metadata and catalog checksum.

Changes to packaging, permissions, or streaming need focused verification of the affected behavior. Browser-facing changes need a real Jellyfin Web check, including native download actions and the configured theme. Before a release, download a package through the browser and compare its entries with the original files. Keep private fixture media, credentials, generated builds, and local verification harnesses out of contributions.

## Releases

Create feature branches from `dev` and open pull requests into `dev`. Merge `dev` into `main` when the changes are ready for release. Build checks run on pushes and pull requests for both branches. Squash feature pull requests; use a merge commit for `dev` into `main` to keep their shared history.

To release, update the four-part version in `meta.json` and the project file, and write the changelog in `meta.json`. Merging the version change into `main` builds and publishes the installer and Jellyfin catalog as `vX.Y.Z.W`. An unchanged, already published version does not create another release. The release workflow can also be run manually on `main` to retry a failed release.

The installer and catalog are attached to a draft before publication. Published releases are immutable. The catalog keeps older versions so Jellyfin can select a compatible release. The tracked `manifest.json` is a template; the generated release asset is the installable catalog.
