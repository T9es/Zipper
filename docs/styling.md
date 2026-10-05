# Styling Zipper

Zipper adds its own actions and dialogs to Jellyfin Web. Its detail action inherits the native download button's presentation classes and icon. Its menu action follows the native menu entry. Neither takes over Jellyfin's download handlers.

Dialog styles are scoped to `.zipper-overlay` and `.zipper-dialog`; administrator-page styles are scoped to `#zipperConfigurationPage`. Jellyfin's `--jf-palette-*` variables provide colors, with older Jellyfin variable names and built-in fallbacks where needed. Zipper does not depend on a specific theme plugin.

Theme authors can override these variables on a Zipper dialog or an ancestor:

| Variable | Purpose |
| --- | --- |
| `--zipper-surface` | Dialog surface |
| `--zipper-text-primary` | Primary text |
| `--zipper-text-secondary` | Supporting text |
| `--zipper-divider` | Dividers and borders |
| `--zipper-accent` | Selection and focus color |
| `--zipper-accent-contrast` | Text on an accented control |
| `--zipper-action-hover` | Hovered row or control |
| `--zipper-error` | Errors |

For example:

```css
.zipper-dialog {
    --zipper-surface: #202020;
    --zipper-accent: #007ba5;
    --zipper-accent-contrast: #ffffff;
}
```

Use Zipper's classes or `[data-zipper-owned]` markers when targeting its elements. Avoid global `button`, `input`, or Jellyfin download-class overrides. Keep visible focus, readable contrast, touch targets, overflow handling, and dialog scrolling intact. Check long titles and filenames, translated labels, narrow portrait and landscape screens, and light and dark palettes after a styling change.
