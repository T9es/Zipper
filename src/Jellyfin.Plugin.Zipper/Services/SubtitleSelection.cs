namespace Jellyfin.Plugin.Zipper.Services;

internal static class SubtitleSelection
{
    public static readonly IReadOnlySet<string> SupportedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ".ass", ".mks", ".sami", ".smi", ".srt", ".ssa", ".sub", ".sup", ".vtt", ".idx"
    };
}
