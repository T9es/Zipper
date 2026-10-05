using System.Security.Cryptography;
using System.Text;
using Jellyfin.Database.Implementations.Entities;

namespace Jellyfin.Plugin.Zipper.Services;

internal sealed class PackageJob
{
    public required Guid Id { get; init; }
    public required Guid UserId { get; init; }
    public required Guid RootItemId { get; init; }
    public required string Title { get; init; }
    public required PackageRequest Request { get; init; }
    public required string ExpectedFingerprint { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset RetainUntil { get; set; }
    public string State { get; set; } = "ready";
    public string? Error { get; set; }
    public long BytesSentByServer;
    public long PayloadBytesRead;
    public CancellationTokenSource? Cancellation { get; set; }
}

internal sealed record DownloadLease(
    Guid JobId,
    Guid OwnerId,
    string ExpectedFingerprint,
    PackageRequest Request,
    CancellationTokenSource CancellationSource,
    CancellationToken CancellationToken,
    PackageJob Job);

public sealed class PackageCoordinator(
    PackageResolver resolver,
    ZipperAuthorizationService authorization)
{
    private static readonly TimeSpan TicketLifetime = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan JobRetention = TimeSpan.FromMinutes(30);
    private readonly object _gate = new();
    private readonly Dictionary<Guid, PackageJob> _jobs = [];
    private readonly Dictionary<string, TicketRecord> _tickets = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, int> _activePerUser = [];
    private readonly HashSet<Guid> _activeJobs = [];
    private int _activeCount;
    private int _planningCount;

    public CatalogDto GetCatalog(Guid itemId, User user, CancellationToken cancellationToken) =>
        WithPlanning(cancellationToken, () => resolver.GetCatalog(itemId, user));

    public PreviewDto Preview(PackageRequest request, User user, CancellationToken cancellationToken)
    {
        var package = WithPlanning(cancellationToken, () => resolver.Resolve(request, user));
        var warnings = package.Warnings.ToList();
        if (package.Entries.Count > 100)
        {
            warnings.Add("Only the first 100 archive file names are shown in this preview.");
        }

        return new PreviewDto(package.RootItemId, package.Title, package.ItemType, package.Request.Mode,
            package.ItemCount, package.Entries.Count, package.TotalBytes,
            package.Entries.Take(100).Select(entry => entry.ArchivePath).ToArray(),
            package.Tracks, warnings.Distinct().Take(30).ToArray(), true);
    }

    public PackageCreatedDto Create(PackageRequest request, User user, CancellationToken cancellationToken)
    {
        _ = authorization.GetAuthorizedUser(user.Id);
        var package = WithPlanning(cancellationToken, () => resolver.Resolve(request, user));
        return CreateResolved(package);
    }

    public PackageCreatedDto Retry(Guid jobId, User user, CancellationToken cancellationToken)
    {
        PackageJob previous;
        lock (_gate)
        {
            PruneLocked(DateTimeOffset.UtcNow);
            if (!_jobs.TryGetValue(jobId, out previous!) || previous.UserId != user.Id)
            {
                throw new ZipperException("jobUnavailable", "This package is unavailable.", 404);
            }

            if (previous.State is "ready" or "validating" or "streaming" or "cancelling")
            {
                throw new ZipperException("jobNotRetryable", "This package is still active.", 409);
            }
        }

        EnsureJobAccessible(previous, user);
        return Create(previous.Request, user, cancellationToken);
    }

    public IReadOnlyList<JobDto> GetJobs(User user)
    {
        PackageJob[] jobs;
        lock (_gate)
        {
            PruneLocked(DateTimeOffset.UtcNow);
            jobs = _jobs.Values.Where(job => job.UserId == user.Id).OrderByDescending(job => job.CreatedAt).Take(32).ToArray();
        }

        var visible = new List<JobDto>(jobs.Length);
        foreach (var job in jobs)
        {
            try
            {
                EnsureJobAccessible(job, user);
                visible.Add(ToDto(job));
            }
            catch (ZipperException)
            {
                // Items whose access changed are hidden from this user's job list.
            }
        }

        return visible;
    }

    public JobDto GetJob(Guid jobId, User user)
    {
        PackageJob job;
        lock (_gate)
        {
            PruneLocked(DateTimeOffset.UtcNow);
            if (!_jobs.TryGetValue(jobId, out job!) || job.UserId != user.Id)
            {
                throw new ZipperException("jobUnavailable", "This package is unavailable.", 404);
            }
        }

        EnsureJobAccessible(job, user);
        return ToDto(job);
    }

    public JobDto Cancel(Guid jobId, User user)
    {
        PackageJob job;
        CancellationTokenSource? cancellation = null;
        lock (_gate)
        {
            PruneLocked(DateTimeOffset.UtcNow);
            if (!_jobs.TryGetValue(jobId, out job!) || job.UserId != user.Id)
            {
                throw new ZipperException("jobUnavailable", "This package is unavailable.", 404);
            }
        }

        EnsureJobAccessible(job, user);
        lock (_gate)
        {
            if (job.State == "ready")
            {
                RemoveTicketsForJobLocked(job.Id);
                job.State = "cancelled";
                job.Error = "Package cancelled.";
                job.UpdatedAt = DateTimeOffset.UtcNow;
            }
            else if (job.State is "validating" or "streaming")
            {
                job.State = "cancelling";
                job.UpdatedAt = DateTimeOffset.UtcNow;
                cancellation = job.Cancellation;
            }
        }

        if (cancellation is not null)
        {
            try { cancellation.Cancel(); } catch (ObjectDisposedException) { }
        }

        return ToDto(job);
    }

    internal DownloadLease ConsumeTicket(string? ticket, CancellationToken requestAborted, CancellationToken applicationStopping)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length != 43 || ticket.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
        {
            throw InvalidTicket();
        }

        var ticketHash = Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(ticket)));
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            PruneLocked(now);
            if (!_tickets.TryGetValue(ticketHash, out var issued)
                || issued.ExpiresAt <= now
                || !_jobs.TryGetValue(issued.JobId, out var job)
                || job.State != "ready")
            {
                if (_tickets.Remove(ticketHash, out var expired) && _jobs.TryGetValue(expired.JobId, out var expiredJob) && expiredJob.State == "ready")
                {
                    expiredJob.State = "expired";
                    expiredJob.Error = "The download ticket expired. Create a new package to download again.";
                    expiredJob.UpdatedAt = now;
                }

                throw InvalidTicket();
            }

            var config = ZipperPlugin.Instance.Configuration;
            var userActive = _activePerUser.GetValueOrDefault(issued.UserId);
            if (_activeCount >= config.MaxConcurrentDownloads || userActive >= config.MaxConcurrentDownloadsPerUser)
            {
                _tickets.Remove(ticketHash);
                job.State = "failed";
                job.Error = "Too many active downloads are using the server. Retry this package shortly.";
                job.UpdatedAt = now;
                throw new ZipperException("downloadBusy", "Too many Zipper downloads are active. Try again shortly.", 429);
            }

            _tickets.Remove(ticketHash);
            var linked = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, applicationStopping);
            job.Cancellation = linked;
            job.State = "validating";
            job.UpdatedAt = now;
            _activeCount++;
            _activeJobs.Add(job.Id);
            _activePerUser[issued.UserId] = userActive + 1;

            return new DownloadLease(job.Id, job.UserId, issued.Fingerprint, Clone(job.Request), linked, linked.Token, job);
        }
    }

    internal ResolvedPackage Revalidate(DownloadLease lease, User user)
    {
        if (lease.OwnerId != user.Id)
        {
            throw InvalidTicket();
        }

        lease.CancellationToken.ThrowIfCancellationRequested();
        var resolved = WithPlanning(lease.CancellationToken, () => resolver.Resolve(lease.Request, user));
        if (!string.Equals(resolved.Fingerprint, lease.ExpectedFingerprint, StringComparison.Ordinal))
        {
            throw new ZipperException("packageChanged", "The selected media or subtitle files changed. Create a new package before downloading.", 409);
        }

        lock (_gate)
        {
            if (!_jobs.TryGetValue(lease.JobId, out var job) || job.State == "cancelling")
            {
                throw new OperationCanceledException(lease.CancellationToken);
            }

            job.State = "streaming";
            job.UpdatedAt = DateTimeOffset.UtcNow;
            job.Error = null;
        }

        return resolved;
    }

    internal void AddProgress(DownloadLease lease, long serverBytes, long payloadBytes)
    {
        Interlocked.Add(ref lease.Job.BytesSentByServer, serverBytes);
        Interlocked.Add(ref lease.Job.PayloadBytesRead, payloadBytes);
    }

    internal void Complete(DownloadLease lease)
    {
        Finish(lease, "completed", null);
    }

    internal void Cancelled(DownloadLease lease)
    {
        Finish(lease, "cancelled", "Package cancelled or client disconnected.");
    }

    internal void Fail(DownloadLease lease, string safeMessage)
    {
        Finish(lease, "failed", safeMessage);
    }

    private PackageCreatedDto CreateResolved(ResolvedPackage package)
    {
        var now = DateTimeOffset.UtcNow;
        var rawTicket = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
        var ticketHash = Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(rawTicket)));
        var expires = now + TicketLifetime;
        var job = new PackageJob
        {
            Id = Guid.NewGuid(),
            UserId = package.OwnerId,
            RootItemId = package.RootItemId,
            Title = package.Title,
            Request = Clone(package.Request),
            ExpectedFingerprint = package.Fingerprint,
            CreatedAt = now,
            UpdatedAt = now,
            RetainUntil = now + JobRetention
        };

        lock (_gate)
        {
            PruneLocked(now);
            var config = ZipperPlugin.Instance.Configuration;
            if (_tickets.Count >= 64 || _tickets.Values.Count(ticket => ticket.UserId == package.OwnerId) >= 2)
            {
                throw new ZipperException("ticketLimit", "This account has too many unused download tickets.", 429);
            }

            if (_activeCount >= config.MaxConcurrentDownloads
                || _activePerUser.GetValueOrDefault(package.OwnerId) >= config.MaxConcurrentDownloadsPerUser)
            {
                throw new ZipperException("downloadBusy", "Too many Zipper downloads are active. Try again shortly.", 429);
            }

            if (config.MaxItems < 1 || config.MaxEntries < 1 || config.MaxPackageBytes < 1)
            {
                throw new ZipperException("invalidServerLimits", "Zipper limits are not configured correctly.", 503);
            }

            if (_jobs.Values.Count(existing => existing.UserId == package.OwnerId) >= 32
                && !EvictOldestTerminalJobLocked(package.OwnerId))
            {
                throw new ZipperException("jobLimit", "This account has reached the temporary package history limit.", 429);
            }

            if (_jobs.Count >= 128 && !EvictOldestTerminalJobLocked(null))
            {
                throw new ZipperException("jobLimit", "The server has reached the temporary package history limit.", 429);
            }

            _jobs.Add(job.Id, job);
            _tickets.Add(ticketHash, new TicketRecord(job.Id, package.OwnerId, package.Fingerprint, expires));
        }

        return new PackageCreatedDto(ToDto(job), rawTicket, "/Zipper/Download", expires);
    }

    private void EnsureJobAccessible(PackageJob job, User user)
    {
        _ = authorization.GetAuthorizedUser(user.Id);
        _ = authorization.GetVisibleItem(job.RootItemId, user);
    }

    private T WithPlanning<T>(CancellationToken cancellationToken, Func<T> action)
    {
        var maximum = ZipperPlugin.Instance.Configuration.PlanningConcurrency;
        if (Interlocked.Increment(ref _planningCount) > maximum)
        {
            Interlocked.Decrement(ref _planningCount);
            throw new ZipperException("planningBusy", "Zipper is preparing other packages. Try again shortly.", 429);
        }

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var result = action();
            cancellationToken.ThrowIfCancellationRequested();
            return result;
        }
        finally
        {
            Interlocked.Decrement(ref _planningCount);
        }
    }

    private void Finish(DownloadLease lease, string state, string? error)
    {
        lock (_gate)
        {
            if (!_jobs.TryGetValue(lease.JobId, out var job))
            {
                ReleaseActiveLocked(lease, null);
                return;
            }

            job.State = state;
            job.Error = error;
            job.UpdatedAt = DateTimeOffset.UtcNow;
            job.RetainUntil = job.UpdatedAt + JobRetention;
            var cancellation = job.Cancellation;
            job.Cancellation = null;
            ReleaseActiveLocked(lease, cancellation);
        }
    }

    private void ReleaseActiveLocked(DownloadLease lease, CancellationTokenSource? cancellation)
    {
        if (!_activeJobs.Remove(lease.JobId))
        {
            cancellation?.Dispose();
            return;
        }

        _activeCount = Math.Max(0, _activeCount - 1);
        var userCount = _activePerUser.GetValueOrDefault(lease.OwnerId);
        if (userCount <= 1)
        {
            _activePerUser.Remove(lease.OwnerId);
        }
        else
        {
            _activePerUser[lease.OwnerId] = userCount - 1;
        }

        if (cancellation is not null)
        {
            cancellation.Dispose();
        }
    }

    private void PruneLocked(DateTimeOffset now)
    {
        foreach (var pair in _tickets.Where(pair => pair.Value.ExpiresAt <= now).ToArray())
        {
            _tickets.Remove(pair.Key);
            if (_jobs.TryGetValue(pair.Value.JobId, out var job) && job.State == "ready")
            {
                job.State = "expired";
                job.Error = "The download ticket expired. Create a new package to download again.";
                job.UpdatedAt = now;
            }
        }

        foreach (var id in _jobs.Where(pair => pair.Value.RetainUntil <= now
                && pair.Value.State is not ("validating" or "streaming" or "cancelling"))
            .Select(pair => pair.Key)
            .ToArray())
        {
            _jobs.Remove(id);
            RemoveTicketsForJobLocked(id);
        }
    }

    private void RemoveTicketsForJobLocked(Guid jobId)
    {
        foreach (var key in _tickets.Where(pair => pair.Value.JobId == jobId).Select(pair => pair.Key).ToArray())
        {
            _tickets.Remove(key);
        }
    }

    private bool EvictOldestTerminalJobLocked(Guid? userId)
    {
        var oldest = _jobs.Values
            .Where(job => (!userId.HasValue || job.UserId == userId.Value)
                && (job.State is "completed" or "failed" or "cancelled" or "expired"))
            .OrderBy(job => job.CreatedAt)
            .ThenBy(job => job.Id)
            .FirstOrDefault();
        if (oldest is null)
        {
            return false;
        }

        RemoveTicketsForJobLocked(oldest.Id);
        return _jobs.Remove(oldest.Id);
    }

    private static PackageRequest Clone(PackageRequest request) => new()
    {
        ItemId = request.ItemId,
        Mode = request.Mode,
        Languages = request.Languages.ToList(),
        SubtitleIndices = request.SubtitleIndices.ToList(),
        SeasonIds = request.SeasonIds.ToList(),
        MediaSourceId = request.MediaSourceId
    };

    private JobDto ToDto(PackageJob job)
    {
        lock (_gate)
        {
            var state = job.State;
            return new JobDto(
                job.Id,
                job.RootItemId,
                job.Title,
                state,
                job.CreatedAt,
                job.UpdatedAt,
                Interlocked.Read(ref job.BytesSentByServer),
                Interlocked.Read(ref job.PayloadBytesRead),
                job.Error,
                state is "failed" or "cancelled" or "expired" or "completed");
        }
    }

    private static ZipperException InvalidTicket() => new("ticketUnavailable", "This download ticket is expired or already used.", 410);

    private sealed record TicketRecord(Guid JobId, Guid UserId, string Fingerprint, DateTimeOffset ExpiresAt);
}
