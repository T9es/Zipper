# Installation

Zipper requires Jellyfin Server and Web **12.0.0** and [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) **3.0.1.0**. Users need Jellyfin's download permission and access to the selected media.

For an unreleased version, [build from source](../CONTRIBUTING.md#building) and install manually.

## Plugin catalog

1. Open **Dashboard → Plugins → Repositories** and add the File Transformation repository:

   ```text
   https://www.iamparadox.dev/jellyfin/plugins/manifest.json
   ```

2. Install File Transformation **3.0.1.0**, then restart Jellyfin.
3. Add the Zipper repository:

   ```text
   https://github.com/T9es/Zipper/releases/latest/download/manifest.json
   ```

4. Install **Zipper**, restart Jellyfin, and reload Jellyfin Web.

## Manual installation

Install File Transformation first. Download the installer ZIP from [Releases](https://github.com/T9es/Zipper/releases), or build it from source.

Stop Jellyfin and extract the ZIP contents directly into `plugins/Zipper_<version>/` in the server's data directory. For version `1.0.0.0`, use `plugins/Zipper_1.0.0.0/`. Start Jellyfin and reload Jellyfin Web.

See Jellyfin's [manual installation](https://jellyfin.org/docs/general/server/plugins/#manual) and [data directory](https://jellyfin.org/docs/general/administration/configuration/#data-directory) documentation for platform-specific paths.

## Using Zipper

Open a movie, episode, season, or series and choose **Download ZIP**. By default, the ZIP includes the original media and all supported external subtitle tracks that Jellyfin associates with it. You can change the contents, select subtitle languages or tracks, and select seasons for a series.

**Preferences** saves your defaults to your account. **Downloads** lets you cancel or retry a transfer. Your browser tracks download progress; **Sent** means Zipper finished sending the response. Interrupted downloads cannot be resumed; retry starts a new transfer.

Administrators can change package and concurrency limits under **Dashboard → Plugins → Zipper**. Defaults allow 250 media items, 3,000 files, and 200 GiB per package, with two concurrent transfers across the server and one per user.

## Troubleshooting

- **Download ZIP is missing:** check the user's download permission, File Transformation installation, and Zipper's Web integration setting. Restart Jellyfin and reload the browser after installation.
- **A subtitle is missing:** check that Jellyfin lists it as an external track for the selected media version. Embedded subtitles remain inside the original media file.
- **The package exceeds a limit:** select fewer seasons or tracks, or ask the administrator to review the limits.
- **A transfer was interrupted:** retry from Downloads and discard the incomplete ZIP.

The interface is for Jellyfin Web. Native apps and other Jellyfin versions have not been verified.
