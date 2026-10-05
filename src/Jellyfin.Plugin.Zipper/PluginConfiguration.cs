using System.Text.Json;
using Jellyfin.Plugin.Zipper.Services;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Zipper;

public sealed class PluginConfiguration : BasePluginConfiguration
{
    public bool PluginEnabled { get; set; } = true;
    public bool UiEnabled { get; set; } = true;
    public bool EnableMovies { get; set; } = true;
    public bool EnableEpisodes { get; set; } = true;
    public bool EnableSeasons { get; set; } = true;
    public bool EnableSeries { get; set; } = true;
    public int MaxConcurrentDownloads { get; set; } = 2;
    public int MaxConcurrentDownloadsPerUser { get; set; } = 1;
    public int MaxItems { get; set; } = 250;
    public int MaxEntries { get; set; } = 3000;
    public long MaxPackageBytes { get; set; } = 200L * 1024 * 1024 * 1024;
    public int PlanningConcurrency { get; set; } = 4;
    public List<string> AllowedSubtitleExtensions { get; set; } = [".ass", ".mks", ".sami", ".smi", ".srt", ".ssa", ".sub", ".sup", ".vtt", ".idx"];

    public void Normalize()
    {
        MaxConcurrentDownloads = Math.Clamp(MaxConcurrentDownloads, 1, 8);
        MaxConcurrentDownloadsPerUser = Math.Clamp(MaxConcurrentDownloadsPerUser, 1, MaxConcurrentDownloads);
        MaxItems = Math.Clamp(MaxItems, 1, 500);
        MaxEntries = Math.Clamp(MaxEntries, 1, 10_000);
        MaxPackageBytes = Math.Clamp(MaxPackageBytes, 1, 2L * 1024 * 1024 * 1024 * 1024);
        PlanningConcurrency = Math.Clamp(PlanningConcurrency, 1, 16);

        var permitted = SubtitleSelection.SupportedExtensions;
        AllowedSubtitleExtensions = (AllowedSubtitleExtensions ?? [])
            .Where(extension => extension is not null && permitted.Contains(extension.Trim(), StringComparer.OrdinalIgnoreCase))
            .Select(extension => extension.Trim().ToLowerInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(permitted.Count)
            .ToList();
    }

    public LimitsDto GetPublicLimits() => new(MaxItems, MaxEntries, MaxPackageBytes, MaxConcurrentDownloads, MaxConcurrentDownloadsPerUser);
}
