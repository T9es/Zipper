using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;

namespace Jellyfin.Plugin.Zipper.Services;

internal sealed record PackageEntry(
    string SourcePath,
    string ArchivePath,
    long Length,
    long LastWriteUtcTicks,
    Guid ItemId,
    int? SubtitleIndex,
    string Kind);

internal sealed class ResolvedPackage
{
    public required PackageRequest Request { get; init; }
    public required Guid OwnerId { get; init; }
    public required Guid RootItemId { get; init; }
    public required string Title { get; init; }
    public required string ItemType { get; init; }
    public required int ItemCount { get; init; }
    public required List<PackageEntry> Entries { get; init; }
    public required List<string> Warnings { get; init; }
    public required long TotalBytes { get; init; }
    public required string Fingerprint { get; init; }
    public required List<SubtitleTrackDto> Tracks { get; init; }
    public required string DownloadFileName { get; init; }
}

internal sealed record ResolvedSource(MediaSourceInfo Source, Video Video, bool IsPrimary);

public sealed class PackageResolver(
    ILibraryManager libraryManager,
    IMediaSourceManager mediaSourceManager,
    ZipperAuthorizationService authorizationService)
{
    private const int SubtitleTrackLimit = 256;

    public CatalogDto GetCatalog(Guid itemId, User user)
    {
        var config = CurrentConfiguration();
        var root = authorizationService.GetVisibleItem(itemId, user);
        var scope = GetScope(root, config);
        if (scope is null)
        {
            throw new ZipperException("unsupportedItem", "Choose a movie, episode, season, or series.");
        }

        var warnings = new List<string>();
        var sourceChoices = new List<MediaSourceChoiceDto>();
        var tracks = new List<SubtitleTrackDto>();
        if (root is Video video && video.CanDownload(user))
        {
            var sources = GetVisibleSources(video, user);
            if (sources.Count > 16)
            {
                throw new ZipperException("tooManySources", "This item has too many media versions to package.", 413);
            }

            for (var index = 0; index < sources.Count; index++)
            {
                var source = sources[index];
                var sourceTracks = GetTrackCatalog(source.Source, warnings).ToArray();
                sourceChoices.Add(new MediaSourceChoiceDto(source.Source.Id, GetSourceLabel(source, index + 1),
                    SafeMetadata(source.Source.Container, 24), source.IsPrimary, sourceTracks));
            }

            var selected = sources.FirstOrDefault(source => source.IsPrimary) ?? sources.FirstOrDefault();
            if (selected is not null)
            {
                tracks = GetTrackCatalog(selected.Source, warnings);
            }
        }

        var seasons = root switch
        {
            Series series => GetSeasons(series, user, 501)
                .Select(season => new SeasonChoiceDto(season.Id, SafeTitle(season.Name, season.Id), season.IndexNumber,
                    GetEpisodeCountCapped(season, user, config.MaxItems + 1)))
                .ToArray(),
            Season season => [new SeasonChoiceDto(season.Id, SafeTitle(season.Name, season.Id), season.IndexNumber,
                GetEpisodeCountCapped(season, user, config.MaxItems + 1))],
            _ => []
        };

        return new CatalogDto(
            root.Id,
            SafeTitle(root.Name, root.Id),
            scope,
            sourceChoices,
            seasons,
            tracks,
            warnings.Distinct().ToArray());
    }

    internal ResolvedPackage Resolve(PackageRequest input, User user)
    {
        var config = CurrentConfiguration();
        var request = ValidateRequest(input);
        var root = authorizationService.GetVisibleItem(request.ItemId, user);
        var scope = GetScope(root, config);
        if (scope is null)
        {
            throw new ZipperException("unsupportedItem", "Choose an enabled movie, episode, season, or series.");
        }

        if (request.MediaSourceId is not null && root is not Video)
        {
            throw new ZipperException("invalidSelection", "A media version can only be selected for a movie or episode.");
        }

        var warnings = new List<string>();
        var episodes = ResolveItems(root, request, user, config, warnings);
        if (episodes.Count == 0)
        {
            throw new ZipperException("emptyPackage", "No downloadable media items are available in this selection.");
        }

        if (episodes.Count > config.MaxItems)
        {
            throw new ZipperException("itemLimitExceeded", "This package exceeds the server item limit. Choose one or more seasons instead.", 413);
        }

        if (request.SubtitleIndices.Count > 0 && episodes.Count != 1)
        {
            throw new ZipperException("invalidSelection", "Track number selections are available for a single movie or episode.");
        }

        var entries = new List<PackageEntry>(Math.Min(config.MaxEntries, 512));
        var sourcePartCount = 0;
        var trackCatalog = new List<SubtitleTrackDto>();
        var archiveFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var archiveDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long totalBytes = 0;
        var subtitleMatches = 0;

        var topFolder = SafeArchiveSegment(root switch
        {
            Episode episodeRoot => episodeRoot.SeriesName,
            Season seasonRoot => seasonRoot.SeriesName,
            _ => root.Name
        }, ArchiveSegmentByteLimit);
        if (root is Movie { ProductionYear: int productionYear })
        {
            topFolder = SafeArchiveSegment($"{root.Name} ({productionYear.ToString(CultureInfo.InvariantCulture)})", ArchiveSegmentByteLimit);
        }

        var seasonFolder = root is Season rootSeason
            ? SeasonFolder(rootSeason.IndexNumber)
            : null;

        foreach (var mediaItem in episodes)
        {
            var current = authorizationService.GetDownloadableItem(mediaItem.Id, user);
            if (current is not Video video)
            {
                throw new ZipperException("itemUnavailable", "One or more selected episodes are unavailable.", 404);
            }

            var sources = GetVisibleSources(video, user);
            var resolvedSource = mediaItem.Id == root.Id && request.MediaSourceId is not null
                ? SelectExplicitSource(video, sources, request.MediaSourceId, user)
                : SelectPrimarySource(sources, video.Id, warnings);

            if (resolvedSource is null)
            {
                throw new ZipperException("mediaSourceUnavailable", "A selected media source is unavailable.");
            }

            var sourceVideos = new List<(Video Video, MediaSourceInfo Source)>();
            var selectedVideo = resolvedSource.Video;
            if (request.SubtitleIndices.Count > 0 && selectedVideo.IsStacked)
            {
                throw new ZipperException("invalidSelection", "Track number selections are unavailable for multipart media.");
            }

            var primaryInfo = ValidateSource(selectedVideo, resolvedSource.Source, user);
            sourceVideos.Add((selectedVideo, primaryInfo));
            if (selectedVideo.IsStacked)
            {
                if (selectedVideo.AdditionalParts.Length > 31)
                {
                    throw new ZipperException("tooManyParts", "This item has too many media parts to package.", 413);
                }

                var partIds = selectedVideo.GetAdditionalPartIds().ToArray();
                foreach (var partId in partIds)
                {
                    if (authorizationService.GetDownloadableItem(partId, user) is not Video part)
                    {
                        throw new ZipperException("downloadNotAllowed", "One or more parts of this item are unavailable to this account.", 403);
                    }

                    var partSources = GetVisibleSources(part, user);
                    var partSource = partSources.FirstOrDefault(candidate => candidate.IsPrimary) ?? partSources.FirstOrDefault();
                    if (partSource is null)
                    {
                        throw new ZipperException("mediaSourceUnavailable", "A part of this item has no downloadable media source.");
                    }

                    sourceVideos.Add((part, ValidateSource(partSource.Video, partSource.Source, user)));
                }
            }

            if (sourceVideos.Count == 0 || sourceVideos.Count > 32)
            {
                throw new ZipperException("tooManyParts", "This item has too many media parts to package.", 413);
            }

            var partNumber = 0;
            foreach (var (partVideo, source) in sourceVideos)
            {
                partNumber++;
                var partSuffix = sourceVideos.Count > 1
                    ? $" - Part {partNumber.ToString("00", CultureInfo.InvariantCulture)}"
                    : string.Empty;
                var entrySeasonFolder = root is Season ? seasonFolder
                    : current is Episode currentEpisode ? SeasonFolder(currentEpisode.ParentIndexNumber)
                    : null;
                sourcePartCount++;
                if (sourcePartCount > config.MaxEntries)
                {
                    throw new ZipperException("entryLimitExceeded", "This package references too many media parts to plan safely.", 413);
                }

                var group = new List<PackageEntry>();
                var groupNames = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                void AddSource(string sourcePath, int? trackIndex, string kind)
                {
                    var originalName = OriginalFileName(sourcePath);
                    var entry = SnapshotFile(sourcePath, originalName, partVideo.Id, trackIndex, kind, rejectReparsePoint: kind == "companion");
                    var nameKey = ArchiveKey(originalName);
                    if (groupNames.TryGetValue(nameKey, out var duplicate))
                    {
                        var previous = group[duplicate];
                        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
                        if (!string.Equals(previous.SourcePath, entry.SourcePath, comparison)
                            || !string.Equals(previous.ArchivePath, originalName, StringComparison.Ordinal))
                        {
                            throw new ZipperException("filenameCollision", "Some selected files share a filename. Choose fewer subtitle tracks to preserve their original names.");
                        }

                        if (kind == "companion")
                        {
                            group[duplicate] = entry;
                        }

                        return;
                    }

                    groupNames.Add(nameKey, group.Count);
                    group.Add(entry);
                }

                if (!request.Mode.Equals(ZipperModes.SubtitlesOnly, StringComparison.Ordinal))
                {
                    AddSource(source.Path, null, "media");
                }

                if (!request.Mode.Equals(ZipperModes.MediaOnly, StringComparison.Ordinal))
                {
                    var selectedTracks = SelectTracks(source, request, episodes.Count == 1, warnings);
                    foreach (var track in selectedTracks.OrderBy(track => track.Stream.Index))
                    {
                        if (trackCatalog.Count >= 10_000)
                        {
                            throw new ZipperException("trackLimitExceeded", "This selection references too many subtitle tracks to plan safely. Choose fewer episodes.", 413);
                        }

                        var trackNumber = track.Stream.Index;
                        AddSource(track.Stream.Path!, trackNumber, "subtitle");
                        subtitleMatches++;

                        if (track.Companion is not null)
                        {
                            AddSource(track.Companion, trackNumber, "companion");
                        }

                        trackCatalog.Add(ToTrackDto(track.Stream));
                    }
                }

                if (group.Count == 0)
                {
                    continue;
                }

                EnsureEntryLimit(entries.Count + group.Count, config.MaxEntries);
                var folder = ReserveGroupFolder(archiveFiles, archiveDirectories,
                    JoinFolder(topFolder, entrySeasonFolder, string.Empty).TrimEnd('/'),
                    CreateItemFolder(current) + partSuffix, group);
                foreach (var entry in group)
                {
                    entries.Add(entry with { ArchivePath = $"{folder}/{entry.ArchivePath}" });
                    totalBytes = AddSize(totalBytes, entry.Length, config.MaxPackageBytes);
                }
            }
        }

        if (request.Mode == ZipperModes.SubtitlesOnly && subtitleMatches == 0)
        {
            throw new ZipperException("noSubtitles", "No supported external subtitles matched this selection.");
        }

        if (entries.Count == 0)
        {
            throw new ZipperException("emptyPackage", "No supported files matched this selection.");
        }

        if (entries.Count > config.MaxEntries)
        {
            throw new ZipperException("entryLimitExceeded", "This package exceeds the server file-count limit.", 413);
        }

        var title = SafeTitle(root.Name, root.Id);
        if (request.Mode != ZipperModes.MediaOnly && subtitleMatches == 0)
        {
            warnings.Add("No supported external subtitle tracks matched. The original media remains unchanged.");
        }

        var fingerprint = ComputeFingerprint(request, entries);
        var filename = SafeDownloadName(title, root is Season || root is Series, root is Season season ? season.IndexNumber : null);
        return new ResolvedPackage
        {
            Request = request,
            OwnerId = user.Id,
            RootItemId = root.Id,
            Title = title,
            ItemType = scope,
            ItemCount = episodes.Count,
            Entries = entries,
            Warnings = warnings.Distinct().Take(30).ToList(),
            TotalBytes = totalBytes,
            Fingerprint = fingerprint,
            Tracks = trackCatalog.DistinctBy(track => (track.Index, track.Language, track.Title)).Take(100).ToList(),
            DownloadFileName = filename
        };
    }

    private List<BaseItem> ResolveItems(BaseItem root, PackageRequest request, User user, PluginConfiguration config, List<string> warnings)
    {
        if (root is Movie or Episode)
        {
            _ = authorizationService.GetDownloadableItem(root.Id, user);
            return [root];
        }

        IReadOnlyList<Season> seasons;
        if (root is Season season)
        {
            seasons = [season];
            if (request.SeasonIds.Count > 0 && (request.SeasonIds.Count != 1 || request.SeasonIds[0] != season.Id))
            {
                throw new ZipperException("invalidSelection", "The selected season does not match this item.");
            }
        }
        else if (root is Series series)
        {
            var candidates = GetUnfilteredSeasons(series, 501);
            if (candidates.Count >= 501)
            {
                throw new ZipperException("itemLimitExceeded", "This series has too many seasons to plan safely. Choose a smaller series or use season packages.", 413);
            }
            if (request.SeasonIds.Count > 0)
            {
                var allowed = candidates.Select(item => item.Id).ToHashSet();
                if (request.SeasonIds.Any(id => !allowed.Contains(id)))
                {
                    throw new ZipperException("invalidSelection", "One or more selected seasons do not belong to this series.");
                }

                candidates = candidates.Where(item => request.SeasonIds.Contains(item.Id)).ToArray();
            }

            if (candidates.Count > config.MaxItems)
            {
                throw new ZipperException("itemLimitExceeded", "This series has too many seasons for one package. Choose a smaller set of seasons.", 413);
            }

            var visibleSeasons = new List<Season>(candidates.Count);
            foreach (var candidate in candidates)
            {
                if (authorizationService.GetVisibleItem(candidate.Id, user) is not Season visibleSeason)
                {
                    throw new ZipperException("itemUnavailable", "One or more selected seasons are unavailable.", 404);
                }

                visibleSeasons.Add(visibleSeason);
            }

            seasons = visibleSeasons;
        }
        else
        {
            throw new ZipperException("unsupportedItem", "Choose a movie, episode, season, or series.");
        }

        if (seasons.Count == 0)
        {
            throw new ZipperException("emptyPackage", "No seasons are available in this selection.");
        }

        var items = new List<BaseItem>(Math.Min(config.MaxItems + 1, 256));
        foreach (var selectedSeason in seasons)
        {
            var query = new InternalItemsQuery
            {
                Parent = selectedSeason,
                IncludeItemTypes = [BaseItemKind.Episode],
                IsVirtualItem = false,
                Limit = config.MaxItems + 1,
                DtoOptions = new DtoOptions(false)
            };
            foreach (var candidate in libraryManager.GetItemList(query))
            {
                if (candidate is not Episode)
                {
                    continue;
                }

                var visible = libraryManager.GetItemById<BaseItem>(candidate.Id, user);
                if (visible is null || !visible.IsVisibleStandalone(user) || !visible.CanDownload(user))
                {
                    throw new ZipperException("downloadNotAllowed", "One or more items in this selection are unavailable to this account.", 403);
                }

                items.Add(visible);
                if (items.Count > config.MaxItems)
                {
                    throw new ZipperException("itemLimitExceeded", "This package exceeds the server item limit. Choose one or more seasons instead.", 413);
                }
            }
        }

        return items
            .DistinctBy(item => item.Id)
            .OrderBy(item => item.ParentIndexNumber ?? -1)
            .ThenBy(item => item.IndexNumber ?? int.MaxValue)
            .ThenBy(item => item.SortName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private IReadOnlyList<Season> GetSeasons(Series series, User user, int limit)
    {
        return GetUnfilteredSeasons(series, limit)
            .Select(item => libraryManager.GetItemById<BaseItem>(item.Id, user))
            .OfType<Season>()
            .Where(item => item.IsVisibleStandalone(user))
            .Take(limit)
            .ToArray();
    }

    private IReadOnlyList<Season> GetUnfilteredSeasons(Series series, int limit)
    {
        var query = new InternalItemsQuery
        {
            SeriesPresentationUniqueKey = series.GetPresentationUniqueKey(),
            IncludeItemTypes = [BaseItemKind.Season],
            IsVirtualItem = false,
            Limit = limit,
            DtoOptions = new DtoOptions(false)
        };

        return libraryManager.GetItemList(query)
            .OfType<Season>()
            .OrderBy(item => item.IndexNumber ?? int.MaxValue)
            .ThenBy(item => item.SortName, StringComparer.OrdinalIgnoreCase)
            .Take(limit)
            .ToArray();
    }

    private int? GetEpisodeCountCapped(Season season, User user, int limit)
    {
        var query = new InternalItemsQuery(user)
        {
            Parent = season,
            IncludeItemTypes = [BaseItemKind.Episode],
            IsVirtualItem = false,
            DtoOptions = new DtoOptions(false)
        };
        var count = libraryManager.GetCount(query);
        return count >= limit ? null : count;
    }

    private List<ResolvedSource> GetVisibleSources(Video video, User user)
    {
        var candidates = mediaSourceManager.GetStaticMediaSources(video, enablePathSubstitution: false, user)
            .Where(source => source.Type != MediaSourceType.Placeholder
                && source.Protocol == MediaProtocol.File
                && !source.IsRemote
                && Guid.TryParse(source.Id, out _))
            .Take(17)
            .ToList();

        var result = new List<ResolvedSource>();
        foreach (var source in candidates)
        {
            if (!Guid.TryParse(source.Id, out var sourceItemId))
            {
                continue;
            }

            var sourceItem = libraryManager.GetItemById<Video>(sourceItemId, user);
            if (sourceItem is null || !sourceItem.IsVisibleStandalone(user) || !sourceItem.CanDownload(user))
            {
                continue;
            }

            var belongsToRoot = sourceItem.Id == video.Id
                || string.Equals(sourceItem.GetPresentationUniqueKey(), video.GetPresentationUniqueKey(), StringComparison.Ordinal);
            if (!belongsToRoot)
            {
                continue;
            }

            result.Add(new ResolvedSource(source, sourceItem, sourceItem.Id == video.Id));
        }

        return result.OrderByDescending(source => source.IsPrimary).ThenBy(source => source.Video.Id).ToList();
    }

    private static string GetSourceLabel(ResolvedSource resolved, int versionNumber)
    {
        var parts = new List<string>(4) { resolved.IsPrimary ? "Primary version" : $"Version {versionNumber.ToString(CultureInfo.InvariantCulture)}" };
        var container = SafeMetadata(resolved.Source.Container, 12);
        if (!string.IsNullOrWhiteSpace(container))
        {
            parts.Add(SafeSegment(container).ToUpperInvariant());
        }

        var videoStream = (resolved.Source.MediaStreams ?? []).FirstOrDefault(stream => stream.Type == MediaStreamType.Video);
        if (videoStream?.Width is > 0 && videoStream.Height is > 0)
        {
            parts.Add($"{videoStream.Width.Value.ToString(CultureInfo.InvariantCulture)} × {videoStream.Height.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (resolved.Source.Size is > 0)
        {
            parts.Add(FormatBytes(resolved.Source.Size.Value));
        }

        return string.Join(" · ", parts);
    }

    private static string FormatBytes(long bytes)
    {
        var value = (double)bytes;
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }

        return $"{value.ToString("0.#", CultureInfo.InvariantCulture)} {units[unit]}";
    }

    private ResolvedSource? SelectExplicitSource(Video video, IReadOnlyList<ResolvedSource> sources, string id, User user)
    {
        var selected = sources.FirstOrDefault(candidate => Guid.TryParse(candidate.Source.Id, out var sourceId)
            && Guid.TryParse(id, out var requestedId)
            && sourceId == requestedId);
        if (selected is null || selected.Video is null || !selected.Video.CanDownload(user))
        {
            throw new ZipperException("mediaSourceUnavailable", "The selected media version is unavailable.");
        }

        return selected;
    }

    private static ResolvedSource? SelectPrimarySource(IReadOnlyList<ResolvedSource> sources, Guid primaryId, List<string> warnings)
    {
        if (sources.Count == 0)
        {
            return null;
        }

        var primary = sources.FirstOrDefault(source => source.Video.Id == primaryId);
        if (primary is not null)
        {
            if (sources.Count > 1)
            {
                warnings.Add("Additional media versions are available; the primary version was selected.");
            }

            return primary;
        }

        warnings.Add("The primary media version was not available; Jellyfin's first accessible version was selected.");
        return sources[0];
    }

    private MediaSourceInfo ValidateSource(Video owner, MediaSourceInfo source, User user)
    {
        if (!owner.CanDownload(user) || owner.VideoType is VideoType.Dvd or VideoType.BluRay
            || source.Protocol != MediaProtocol.File || source.Type == MediaSourceType.Placeholder || source.IsRemote
            || string.IsNullOrWhiteSpace(source.Path) || !Path.IsPathFullyQualified(source.Path)
            || string.Equals(Path.GetExtension(source.Path), ".strm", StringComparison.OrdinalIgnoreCase))
        {
            throw new ZipperException("mediaSourceUnavailable", "This media source is not a downloadable local file.");
        }

        return source;
    }

    private List<(MediaStream Stream, string? Companion)> SelectTracks(MediaSourceInfo source, PackageRequest request, bool isSingleItem, List<string> warnings)
    {
        var hasSpecificIndices = request.SubtitleIndices.Count > 0;
        if (hasSpecificIndices && !isSingleItem)
        {
            throw new ZipperException("invalidSelection", "Track number selections are available for a single movie or episode.");
        }

        var recognized = (source.MediaStreams ?? [])
            .Where(stream => stream.Type == MediaStreamType.Subtitle && stream.IsExternal && stream.IsExternalUrl != true)
            .Take(SubtitleTrackLimit + 1)
            .ToArray();
        if (recognized.Length > SubtitleTrackLimit)
        {
            throw new ZipperException("tooManySubtitleTracks", "This media source has too many associated subtitle tracks to package safely. Ask the server administrator to correct the track metadata or choose media-only mode.", 413);
        }
        var result = new List<(MediaStream Stream, string? Companion)>();
        var extensions = CurrentConfiguration().AllowedSubtitleExtensions.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var stream in recognized)
        {
            if (hasSpecificIndices && !request.SubtitleIndices.Contains(stream.Index))
            {
                continue;
            }

            if (request.Languages.Count > 0 && !request.Languages.Any(language => LanguageMatches(stream.Language, language)))
            {
                continue;
            }

            var extension = Extension(stream.Path);
            if (!SubtitleSelection.SupportedExtensions.Contains(extension) || !extensions.Contains(extension))
            {
                warnings.Add("Some associated external subtitle tracks use formats the server administrator has not enabled.");
                continue;
            }

            if (string.IsNullOrWhiteSpace(stream.Path) || !Path.IsPathFullyQualified(stream.Path))
            {
                warnings.Add("An associated external subtitle track has no safe local file path and was left out.");
                continue;
            }

            string? companion = null;
            if (extension.Equals(".idx", StringComparison.OrdinalIgnoreCase))
            {
                if (!extensions.Contains(".sub"))
                {
                    warnings.Add("A VobSub subtitle track is disabled because its paired .sub format is disabled.");
                    continue;
                }

                companion = GetIdxCompanion(stream.Path);
                if (companion is null)
                {
                    warnings.Add("A VobSub subtitle track is missing its paired .sub file and was left out.");
                    continue;
                }
            }
            else if (extension.Equals(".sub", StringComparison.OrdinalIgnoreCase) && IsVobSub(stream.Codec))
            {
                if (!extensions.Contains(".idx"))
                {
                    warnings.Add("A VobSub subtitle track is disabled because its paired .idx format is disabled.");
                    continue;
                }

                companion = GetSubIdxCompanion(stream.Path);
                if (companion is null)
                {
                    warnings.Add("A VobSub subtitle track is missing its paired .idx file and was left out.");
                    continue;
                }
            }

            result.Add((stream, companion));
        }

        if (hasSpecificIndices)
        {
            var available = recognized.Select(stream => stream.Index).ToHashSet();
            if (request.SubtitleIndices.Any(index => !available.Contains(index)))
            {
                throw new ZipperException("invalidSelection", "One or more selected subtitle tracks are not associated with this media source.");
            }

            var packagedIndices = result.Select(track => track.Stream.Index).ToHashSet();
            if (request.SubtitleIndices.Any(index => !packagedIndices.Contains(index)))
            {
                throw new ZipperException("unsupportedSubtitle", "The selected subtitle tracks are not available in an enabled file format.");
            }
        }

        return result;
    }

    private List<SubtitleTrackDto> GetTrackCatalog(MediaSourceInfo source, List<string> warnings)
    {
        var tracks = new List<SubtitleTrackDto>();
        var enabled = CurrentConfiguration().AllowedSubtitleExtensions.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var recognized = (source.MediaStreams ?? [])
            .Where(stream => stream.Type == MediaStreamType.Subtitle && stream.IsExternal && stream.IsExternalUrl != true)
            .Take(SubtitleTrackLimit + 1)
            .ToArray();
        if (recognized.Length > SubtitleTrackLimit)
        {
            warnings.Add("A media version has more than 256 associated subtitle tracks. Choose media only or another version.");
        }

        foreach (var stream in recognized.Take(SubtitleTrackLimit))
        {
            var extension = Extension(stream.Path);
            if (!SubtitleSelection.SupportedExtensions.Contains(extension) || !enabled.Contains(extension))
            {
                warnings.Add("Some associated subtitle tracks use formats the administrator has not enabled.");
                continue;
            }

            if (string.IsNullOrWhiteSpace(stream.Path) || !Path.IsPathFullyQualified(stream.Path))
            {
                continue;
            }

            if (extension.Equals(".idx", StringComparison.OrdinalIgnoreCase)
                && (!enabled.Contains(".sub") || GetIdxCompanion(stream.Path) is null))
            {
                warnings.Add("A VobSub subtitle track is missing its paired .sub file or its format is disabled.");
                continue;
            }

            if (extension.Equals(".sub", StringComparison.OrdinalIgnoreCase) && IsVobSub(stream.Codec)
                && (!enabled.Contains(".idx") || GetSubIdxCompanion(stream.Path) is null))
            {
                warnings.Add("A VobSub subtitle track is missing its paired .idx file or its format is disabled.");
                continue;
            }

            tracks.Add(ToTrackDto(stream));
        }

        return tracks;
    }

    private static PackageRequest ValidateRequest(PackageRequest? input)
    {
        if (input is null || input.ItemId == Guid.Empty)
        {
            throw new ZipperException("invalidRequest", "Choose a valid Jellyfin item.");
        }

        if (input.Mode is not (ZipperModes.MediaAndSubtitles or ZipperModes.MediaOnly or ZipperModes.SubtitlesOnly))
        {
            throw new ZipperException("invalidMode", "Choose a supported package type.");
        }

        var languages = input.Languages ?? [];
        var indices = input.SubtitleIndices ?? [];
        var seasonIds = input.SeasonIds ?? [];
        if (languages.Count > 20 || indices.Count > SubtitleTrackLimit || seasonIds.Count > 500
            || languages.Any(language => language is null || language.Length > 35 || language.Length == 0 || !LanguageTagLooksValid(language))
            || indices.Any(index => index < 0)
            || indices.Distinct().Count() != indices.Count
            || seasonIds.Any(id => id == Guid.Empty)
            || seasonIds.Distinct().Count() != seasonIds.Count)
        {
            throw new ZipperException("invalidSelection", "One or more package selections are invalid.");
        }

        string? mediaSourceId = null;
        if (!string.IsNullOrWhiteSpace(input.MediaSourceId))
        {
            if (input.MediaSourceId.Length > 64 || !Guid.TryParse(input.MediaSourceId, out var sourceId) || sourceId == Guid.Empty)
            {
                throw new ZipperException("invalidSelection", "Choose a valid media version.");
            }

            mediaSourceId = sourceId.ToString("N", CultureInfo.InvariantCulture);
        }

        return new PackageRequest
        {
            ItemId = input.ItemId,
            Mode = input.Mode,
            Languages = languages.Select(language => language.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            SubtitleIndices = indices.ToList(),
            SeasonIds = seasonIds.ToList(),
            MediaSourceId = mediaSourceId
        };
    }

    private static string? GetScope(BaseItem item, PluginConfiguration config) => item switch
    {
        Movie when config.EnableMovies => "movie",
        Episode when config.EnableEpisodes => "episode",
        Season when config.EnableSeasons => "season",
        Series when config.EnableSeries => "series",
        _ => null
    };

    private static string CreateItemFolder(BaseItem current)
    {
        if (current is Episode episode)
        {
            var seasonNumber = episode.ParentIndexNumber;
            var episodeNumber = episode.IndexNumber;
            var code = seasonNumber.HasValue && episodeNumber.HasValue
                ? $"S{seasonNumber.Value.ToString("00", CultureInfo.InvariantCulture)}E{episodeNumber.Value.ToString("00", CultureInfo.InvariantCulture)}"
                : $"{seasonNumber?.ToString(CultureInfo.InvariantCulture) ?? "S?"}-{episodeNumber?.ToString(CultureInfo.InvariantCulture) ?? "E?"}";
            var prefix = $"{code} - ";
            return prefix + SafeArchiveSegment(episode.Name, ItemFolderByteLimit - Encoding.UTF8.GetByteCount(prefix));
        }

        return SafeArchiveSegment(current.Name, ItemFolderByteLimit);
    }

    private static string JoinFolder(string top, string? season, string filename) => season is null
        ? $"{top}/{filename}"
        : $"{top}/{season}/{filename}";

    private static string SeasonFolder(int? seasonNumber) => seasonNumber.HasValue
        ? $"Season {seasonNumber.Value.ToString("00", CultureInfo.InvariantCulture)}"
        : "Season Unknown";

    private static string Extension(string? path) => Path.GetExtension(path ?? string.Empty);

    private static string? GetIdxCompanion(string path)
    {
        var candidate = Path.ChangeExtension(path, ".sub");
        try
        {
            if (IsTrustedCompanion(candidate, path))
            {
                return candidate;
            }
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or NotSupportedException)
        {
            return null;
        }

        return null;
    }

    private static string? GetSubIdxCompanion(string path)
    {
        var candidate = Path.ChangeExtension(path, ".idx");
        try
        {
            if (IsTrustedCompanion(candidate, path))
            {
                return candidate;
            }
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or NotSupportedException)
        {
            return null;
        }

        return null;
    }

    private static bool IsTrustedCompanion(string candidate, string associatedPath)
    {
        try
        {
            var candidateDirectory = Path.GetDirectoryName(Path.GetFullPath(candidate));
            var associatedDirectory = Path.GetDirectoryName(Path.GetFullPath(associatedPath));
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!string.Equals(candidateDirectory, associatedDirectory, comparison))
            {
                return false;
            }

            var info = new FileInfo(candidate);
            return info.Exists
                && (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0
                && info.LinkTarget is null;
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }

    private static bool IsVobSub(string? codec) =>
        codec?.Contains("vobsub", StringComparison.OrdinalIgnoreCase) == true
        || codec?.Contains("dvdsub", StringComparison.OrdinalIgnoreCase) == true
        || codec?.Contains("dvd_subtitle", StringComparison.OrdinalIgnoreCase) == true
        || codec?.Contains("dvd subtitle", StringComparison.OrdinalIgnoreCase) == true;

    private static PackageEntry SnapshotFile(
        string sourcePath,
        string archivePath,
        Guid itemId,
        int? trackIndex,
        string kind,
        bool rejectReparsePoint = false)
    {
        try
        {
            var info = new FileInfo(sourcePath);
            if (!info.Exists)
            {
                throw new ZipperException("sourceUnavailable", "A selected media or subtitle file is unavailable.", 409);
            }

            var isReparsePoint = (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.LinkTarget is not null;
            if (rejectReparsePoint && isReparsePoint)
            {
                throw new ZipperException("sourceUnavailable", "A selected media or subtitle file is unavailable.", 409);
            }

            if (isReparsePoint)
            {
                info = info.ResolveLinkTarget(returnFinalTarget: true) as FileInfo
                    ?? throw new ZipperException("sourceUnavailable", "A selected media or subtitle file is unavailable.", 409);
            }

            if (!info.Exists
                || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0
                || info.LinkTarget is not null)
            {
                throw new ZipperException("sourceUnavailable", "A selected media or subtitle file is unavailable.", 409);
            }

            return new PackageEntry(Path.GetFullPath(info.FullName), archivePath, info.Length, info.LastWriteTimeUtc.Ticks, itemId, trackIndex, kind);
        }
        catch (ZipperException)
        {
            throw;
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            throw new ZipperException("sourceUnavailable", "A selected media or subtitle file is unavailable.", 409);
        }
    }

    private static long AddSize(long current, long addition, long maxBytes)
    {
        if (addition < 0 || current > maxBytes - addition)
        {
            throw new ZipperException("sizeLimitExceeded", "This package exceeds the server size limit.", 413);
        }

        return current + addition;
    }

    private const int ArchiveSegmentByteLimit = 240;
    private const int ItemFolderByteLimit = 110;

    private static string OriginalFileName(string sourcePath)
    {
        var name = Path.GetFileName(sourcePath);
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.Length > 255
            || Encoding.UTF8.GetByteCount(name) > 1024
            || name.EndsWith('.') || name.EndsWith(' ')
            || name.Any(character => char.IsControl(character) || "<>:\"/\\|?*".Contains(character)))
        {
            throw new ZipperException("unsafeFilename", "A selected file has a filename that cannot be safely preserved in this package.");
        }

        try
        {
            _ = name.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            throw new ZipperException("unsafeFilename", "A selected file has a filename that cannot be safely preserved in this package.");
        }

        if (IsDeviceName(name))
        {
            throw new ZipperException("unsafeFilename", "A selected file has a filename that cannot be safely preserved in this package.");
        }

        return name;
    }

    private static bool IsDeviceName(string name)
    {
        var deviceName = name.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        return deviceName is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$"
            || (deviceName.Length == 4 && (deviceName.StartsWith("COM", StringComparison.Ordinal) || deviceName.StartsWith("LPT", StringComparison.Ordinal))
                && (char.IsAsciiDigit(deviceName[3]) || deviceName[3] is '¹' or '²' or '³'));
    }

    private static string ArchiveKey(string path) => path.Normalize(NormalizationForm.FormC);

    private static IEnumerable<string> ArchiveParentKeys(string path)
    {
        for (var slash = path.IndexOf('/'); slash >= 0; slash = path.IndexOf('/', slash + 1))
        {
            yield return ArchiveKey(path[..slash]);
        }
    }

    private static string ReserveGroupFolder(HashSet<string> files, HashSet<string> directories,
        string baseFolder, string itemFolder, IReadOnlyList<PackageEntry> group)
    {
        bool CanPlace(string folder)
        {
            foreach (var entry in group)
            {
                var key = ArchiveKey($"{folder}/{entry.ArchivePath}");
                if (files.Contains(key) || directories.Contains(key) || ArchiveParentKeys(key).Any(files.Contains))
                {
                    return false;
                }
            }

            return true;
        }

        var selectedFolder = baseFolder;
        if (!CanPlace(selectedFolder))
        {
            selectedFolder = string.Empty;
            for (var number = 1; number < 10_000; number++)
            {
                var suffix = number == 1 ? string.Empty : $" ({number.ToString(CultureInfo.InvariantCulture)})";
                var name = SafeArchiveSegment(itemFolder, 160 - Encoding.UTF8.GetByteCount(suffix)) + suffix;
                var candidate = $"{baseFolder}/{name}";
                if (!directories.Contains(ArchiveKey(candidate)) && CanPlace(candidate))
                {
                    selectedFolder = candidate;
                    break;
                }
            }

            if (selectedFolder.Length == 0)
            {
                throw new ZipperException("filenameCollision", "This package contains too many conflicting filenames. Choose fewer items.", 413);
            }
        }

        foreach (var entry in group)
        {
            var key = ArchiveKey($"{selectedFolder}/{entry.ArchivePath}");
            files.Add(key);
            foreach (var parent in ArchiveParentKeys(key))
            {
                directories.Add(parent);
            }
        }

        return selectedFolder;
    }

    private static string SafeSegment(string? input, int maxLength = 150)
        => SafeSegment(input, maxLength, int.MaxValue);

    private static string SafeArchiveSegment(string? input, int maxUtf8Bytes, int maxLength = 150)
        => SafeSegment(input, maxLength, maxUtf8Bytes);

    private static string SafeSegment(string? input, int maxLength, int maxUtf8Bytes)
    {
        var raw = string.IsNullOrWhiteSpace(input) ? "Untitled" : input;
        string value;
        try
        {
            value = raw.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            value = raw;
        }
        var builder = new StringBuilder(Math.Min(value.Length, maxLength));
        var byteCount = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            var safeRune = Rune.IsControl(rune) || rune.Value is '/' or '\\' or '<' or '>' or ':' or '"' or '|' or '?' or '*'
                ? " "
                : rune.ToString();
            var safeRuneBytes = Encoding.UTF8.GetByteCount(safeRune);
            if (builder.Length + safeRune.Length > maxLength || byteCount + safeRuneBytes > maxUtf8Bytes)
            {
                break;
            }

            builder.Append(safeRune);
            byteCount += safeRuneBytes;
        }

        var segment = builder.ToString().Trim().TrimEnd('.');
        while (segment.Contains("..", StringComparison.Ordinal))
        {
            segment = segment.Replace("..", ".", StringComparison.Ordinal);
        }

        if (segment.Length == 0 || segment is "." or "..")
        {
            segment = "Untitled";
        }

        if (IsDeviceName(segment))
        {
            var safeDeviceName = new StringBuilder("_");
            var safeDeviceBytes = 0;
            var safeDeviceChars = 0;
            var remainingBytes = Math.Max(0, maxUtf8Bytes - 1);
            foreach (var rune in segment.EnumerateRunes())
            {
                var runeText = rune.ToString();
                var runeBytes = Encoding.UTF8.GetByteCount(runeText);
                if (safeDeviceBytes + runeBytes > remainingBytes || safeDeviceChars + runeText.Length > maxLength - 1)
                {
                    break;
                }

                safeDeviceName.Append(runeText);
                safeDeviceBytes += runeBytes;
                safeDeviceChars += runeText.Length;
            }

            segment = safeDeviceName.ToString();
        }

        return segment;
    }

    private static void EnsureEntryLimit(int count, int maximum)
    {
        if (count > maximum)
        {
            throw new ZipperException("entryLimitExceeded", "This package exceeds the server file-count limit.", 413);
        }
    }

    private static string SafeTitle(string? title, Guid id) => SafeSegment(string.IsNullOrWhiteSpace(title) ? id.ToString("N", CultureInfo.InvariantCulture) : title);

    private static string SafeDownloadName(string title, bool isBulk, int? seasonNumber)
    {
        var suffix = seasonNumber.HasValue ? $" - Season {seasonNumber.Value.ToString("00", CultureInfo.InvariantCulture)}" : isBulk ? " - Series" : string.Empty;
        var reservedBytes = Encoding.UTF8.GetByteCount(suffix) + Encoding.UTF8.GetByteCount(".zip");
        return SafeArchiveSegment(title, Math.Max(1, 180 - reservedBytes)) + suffix + ".zip";
    }

    private static string? SafeMetadata(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var cleaned = new string(value.Where(character => !char.IsControl(character)).Take(maxLength).ToArray()).Trim();
        return cleaned.Length == 0 ? null : cleaned;
    }

    private static bool LanguageMatches(string? trackLanguage, string selected) =>
        !string.IsNullOrWhiteSpace(trackLanguage)
        && (string.Equals(trackLanguage, selected, StringComparison.OrdinalIgnoreCase)
            || trackLanguage.StartsWith(selected + "-", StringComparison.OrdinalIgnoreCase));

    private static bool LanguageTagLooksValid(string language) =>
        language.Length <= 35 && language[0] is >= 'A' and <= 'Z' or >= 'a' and <= 'z'
        && language.All(character => char.IsAsciiLetterOrDigit(character) || character == '-');

    private static SubtitleTrackDto ToTrackDto(MediaStream stream) => new(
        stream.Index,
        SafeMetadata(stream.Language, 35),
        SafeMetadata(stream.Title, 120),
        SafeMetadata(stream.Codec, 24),
        stream.IsForced,
        stream.IsHearingImpaired);

    private static string ComputeFingerprint(PackageRequest request, IReadOnlyList<PackageEntry> entries)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, request.ItemId.ToString("N", CultureInfo.InvariantCulture));
        Append(hash, request.Mode);
        Append(hash, request.MediaSourceId ?? string.Empty);
        foreach (var language in request.Languages.Order(StringComparer.OrdinalIgnoreCase)) Append(hash, language);
        Append(hash, "languages-end");
        foreach (var index in request.SubtitleIndices.Order()) Append(hash, index.ToString(CultureInfo.InvariantCulture));
        Append(hash, "indices-end");
        foreach (var id in request.SeasonIds.Order()) Append(hash, id.ToString("N", CultureInfo.InvariantCulture));
        Append(hash, "seasons-end");
        foreach (var entry in entries)
        {
            Append(hash, entry.ItemId.ToString("N", CultureInfo.InvariantCulture));
            Append(hash, entry.Kind);
            Append(hash, entry.SubtitleIndex?.ToString(CultureInfo.InvariantCulture) ?? string.Empty);
            Append(hash, entry.SourcePath);
            Append(hash, entry.ArchivePath);
            Append(hash, entry.Length.ToString(CultureInfo.InvariantCulture));
            Append(hash, entry.LastWriteUtcTicks.ToString(CultureInfo.InvariantCulture));
        }

        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static void Append(IncrementalHash hash, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[sizeof(int)];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }

    private static PluginConfiguration CurrentConfiguration()
    {
        return ZipperPlugin.Instance.Configuration;
    }
}
