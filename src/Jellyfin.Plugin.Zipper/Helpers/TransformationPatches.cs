using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.Zipper.Helpers;

public static partial class TransformationPatches
{
    private const string MarkerAttribute = "data-zipper-asset";

    [GeneratedRegex("<link\\b[^>]*\\bdata-zipper-asset=\"[^\"]*\"[^>]*>", RegexOptions.CultureInvariant)]
    private static partial Regex InjectedStyles();

    [GeneratedRegex("<script\\b[^>]*\\bdata-zipper-asset=\"[^\"]*\"[^>]*>\\s*</script>", RegexOptions.CultureInvariant)]
    private static partial Regex InjectedScripts();

    public static string IndexHtml(PatchRequestPayload payload)
    {
        var contents = payload.Contents ?? string.Empty;
        if (contents.Length == 0
            || !contents.Contains("</head>", StringComparison.OrdinalIgnoreCase)
            || !contents.Contains("</body>", StringComparison.OrdinalIgnoreCase))
        {
            return contents;
        }

        contents = InjectedStyles().Replace(contents, string.Empty);
        contents = InjectedScripts().Replace(contents, string.Empty);
        var configuration = ZipperPlugin.Instance?.Configuration;
        if (configuration is null || !configuration.PluginEnabled || !configuration.UiEnabled)
        {
            return contents;
        }

        var assembly = typeof(TransformationPatches).Assembly;
        var version = assembly.GetName().Version?.ToString() ?? "1.0.0.0";
        var buildId = assembly.ManifestModule.ModuleVersionId.ToString("N");
        var cacheQuery = $"?v={Uri.EscapeDataString(version)}&b={buildId}";
        var style = $"<link rel=\"stylesheet\" href=\"../Zipper/zipper.css{cacheQuery}\" {MarkerAttribute}=\"css\" />";
        var localization = $"<script defer src=\"../Zipper/zipper.i18n.js{cacheQuery}\" {MarkerAttribute}=\"i18n\"></script>";
        var script = $"<script defer src=\"../Zipper/zipper.js{cacheQuery}\" {MarkerAttribute}=\"js\"></script>";

        contents = ReplaceBeforeClosingTag(contents, "</head>", style);
        return ReplaceBeforeClosingTag(contents, "</body>", localization + script);
    }

    private static string ReplaceBeforeClosingTag(string contents, string closingTag, string element)
    {
        var index = contents.LastIndexOf(closingTag, StringComparison.OrdinalIgnoreCase);
        return index < 0 ? contents : contents.Insert(index, element);
    }
}
