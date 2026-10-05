using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Zipper;

public static class ZipperModes
{
    public const string MediaAndSubtitles = "mediaAndSubtitles";
    public const string MediaOnly = "mediaOnly";
    public const string SubtitlesOnly = "subtitlesOnly";
}

public sealed class PackageRequest
{
    [JsonPropertyName("itemId")]
    public Guid ItemId { get; set; }

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = ZipperModes.MediaAndSubtitles;

    [JsonPropertyName("languages")]
    public List<string> Languages { get; set; } = [];

    [JsonPropertyName("subtitleIndices")]
    public List<int> SubtitleIndices { get; set; } = [];

    [JsonPropertyName("seasonIds")]
    public List<Guid> SeasonIds { get; set; } = [];

    [JsonPropertyName("mediaSourceId")]
    public string? MediaSourceId { get; set; }
}

public sealed record CapabilityScope(
    [property: JsonPropertyName("itemType")] string ItemType,
    [property: JsonPropertyName("enabled")] bool Enabled);

public sealed record CapabilitiesDto(
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("uiEnabled")] bool UiEnabled,
    [property: JsonPropertyName("modes")] IReadOnlyList<string> Modes,
    [property: JsonPropertyName("scopes")] IReadOnlyList<CapabilityScope> Scopes,
    [property: JsonPropertyName("limits")] LimitsDto Limits);

public sealed record LimitsDto(
    [property: JsonPropertyName("maxItems")] int MaxItems,
    [property: JsonPropertyName("maxEntries")] int MaxEntries,
    [property: JsonPropertyName("maxBytes")] long MaxBytes,
    [property: JsonPropertyName("activeDownloads")] int ActiveDownloads,
    [property: JsonPropertyName("activeDownloadsPerUser")] int ActiveDownloadsPerUser);

public sealed record CatalogDto(
    [property: JsonPropertyName("itemId")] Guid ItemId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("itemType")] string ItemType,
    [property: JsonPropertyName("mediaSources")] IReadOnlyList<MediaSourceChoiceDto> MediaSources,
    [property: JsonPropertyName("seasons")] IReadOnlyList<SeasonChoiceDto> Seasons,
    [property: JsonPropertyName("subtitleTracks")] IReadOnlyList<SubtitleTrackDto> SubtitleTracks,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings);

public sealed record MediaSourceChoiceDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("container")] string? Container,
    [property: JsonPropertyName("isPrimary")] bool IsPrimary,
    [property: JsonPropertyName("subtitleTracks")] IReadOnlyList<SubtitleTrackDto> SubtitleTracks);

public sealed record SeasonChoiceDto(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("seasonNumber")] int? SeasonNumber,
    [property: JsonPropertyName("episodeCount")] int? EpisodeCount);

public sealed record SubtitleTrackDto(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("language")] string? Language,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("codec")] string? Codec,
    [property: JsonPropertyName("isForced")] bool IsForced,
    [property: JsonPropertyName("isHearingImpaired")] bool IsHearingImpaired);

public sealed record PreviewDto(
    [property: JsonPropertyName("itemId")] Guid ItemId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("itemType")] string ItemType,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("itemCount")] int ItemCount,
    [property: JsonPropertyName("entryCount")] int EntryCount,
    [property: JsonPropertyName("totalBytes")] long TotalBytes,
    [property: JsonPropertyName("fileNames")] IReadOnlyList<string> FileNames,
    [property: JsonPropertyName("subtitleTracks")] IReadOnlyList<SubtitleTrackDto> SubtitleTracks,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings,
    [property: JsonPropertyName("canDownload")] bool CanDownload);

public sealed class UserPreferencesDto
{
    [JsonPropertyName("mode")]
    public string Mode { get; set; } = ZipperModes.MediaAndSubtitles;

    [JsonPropertyName("subtitleLanguages")]
    public List<string> SubtitleLanguages { get; set; } = [];
}

public sealed record PackageCreatedDto(
    [property: JsonPropertyName("job")] JobDto Job,
    [property: JsonPropertyName("ticket")] string Ticket,
    [property: JsonPropertyName("downloadPath")] string DownloadPath,
    [property: JsonPropertyName("ticketExpiresAt")] DateTimeOffset TicketExpiresAt);

public sealed record JobDto(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("itemId")] Guid ItemId,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("createdAt")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("updatedAt")] DateTimeOffset UpdatedAt,
    [property: JsonPropertyName("bytesSentByServer")] long BytesSentByServer,
    [property: JsonPropertyName("payloadBytesRead")] long PayloadBytesRead,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("canRetry")] bool CanRetry);

public sealed record ErrorDto(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

public sealed class ZipperException(string code, string message, int statusCode = 400) : Exception(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
}
