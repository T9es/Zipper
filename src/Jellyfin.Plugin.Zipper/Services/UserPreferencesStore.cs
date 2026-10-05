using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.Zipper.Services;

public sealed partial class UserPreferencesStore(IApplicationPaths applicationPaths)
{
    private static readonly SemaphoreSlim FileGate = new(1, 1);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly Regex LanguageTag = LanguageTagRegex();

    public async Task<UserPreferencesDto> GetAsync(Guid userId, CancellationToken cancellationToken)
    {
        await FileGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var path = GetPath(userId);
            if (!File.Exists(path))
            {
                return new UserPreferencesDto();
            }

            var info = new FileInfo(path);
            if (info.Length is <= 0 or > 16 * 1024)
            {
                return new UserPreferencesDto();
            }

            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var value = await JsonSerializer.DeserializeAsync<UserPreferencesDto>(stream, JsonOptions, cancellationToken).ConfigureAwait(false);
            return Normalize(value);
        }
        catch (JsonException)
        {
            return new UserPreferencesDto();
        }
        finally
        {
            FileGate.Release();
        }
    }

    public async Task<UserPreferencesDto> SaveAsync(Guid userId, UserPreferencesDto preferences, CancellationToken cancellationToken)
    {
        var normalized = Normalize(preferences);
        var directory = Path.GetDirectoryName(GetPath(userId))!;
        await FileGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        string? temporaryPath = null;
        try
        {
            Directory.CreateDirectory(directory);
            temporaryPath = Path.Combine(directory, $".{userId:N}.{Guid.NewGuid():N}.tmp");
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, normalized, JsonOptions, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            File.Move(temporaryPath, GetPath(userId), overwrite: true);
            temporaryPath = null;
            return normalized;
        }
        finally
        {
            if (temporaryPath is not null)
            {
                try { File.Delete(temporaryPath); } catch (IOException) { }
            }

            FileGate.Release();
        }
    }

    private string GetPath(Guid userId) => Path.Combine(applicationPaths.PluginConfigurationsPath, "Zipper", "UserPrefs", $"{userId:N}.json");

    private static UserPreferencesDto Normalize(UserPreferencesDto? preferences)
    {
        var mode = preferences?.Mode;
        if (mode is not (ZipperModes.MediaAndSubtitles or ZipperModes.MediaOnly or ZipperModes.SubtitlesOnly))
        {
            mode = ZipperModes.MediaAndSubtitles;
        }

        var languages = (preferences?.SubtitleLanguages ?? [])
            .Where(language => language is not null && language.Length <= 35 && LanguageTag.IsMatch(language))
            .Select(language => language.Trim())
            .Where(language => language.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToList();

        return new UserPreferencesDto { Mode = mode, SubtitleLanguages = languages };
    }

    [GeneratedRegex("^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$", RegexOptions.CultureInvariant)]
    private static partial Regex LanguageTagRegex();
}
