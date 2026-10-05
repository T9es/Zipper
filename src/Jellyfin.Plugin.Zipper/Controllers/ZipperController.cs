using System.Net.Http.Headers;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Zipper.Services;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Zipper.Controllers;

[ApiController]
[Authorize]
[ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
[Route("Zipper")]
[RequestSizeLimit(32 * 1024)]
public sealed class ZipperController(
    ZipperAuthorizationService authorization,
    PackageCoordinator coordinator,
    UserPreferencesStore preferences,
    StreamingZipWriter writer,
    IHostApplicationLifetime applicationLifetime,
    ILogger<ZipperController> logger) : ControllerBase
{
    [HttpGet("Capabilities")]
    public IActionResult GetCapabilities() => RunSafe(() =>
    {
        _ = CurrentUser();
        var config = ZipperPlugin.Instance.Configuration;
        return Ok(new CapabilitiesDto(
            config.PluginEnabled,
            config.UiEnabled,
            [ZipperModes.MediaAndSubtitles, ZipperModes.MediaOnly, ZipperModes.SubtitlesOnly],
            [
                new CapabilityScope("movie", config.EnableMovies),
                new CapabilityScope("episode", config.EnableEpisodes),
                new CapabilityScope("season", config.EnableSeasons),
                new CapabilityScope("series", config.EnableSeries)
            ],
            config.GetPublicLimits()));
    });

    [HttpGet("Catalog/{itemId:guid}")]
    public IActionResult GetCatalog(Guid itemId) => RunSafe(() =>
    {
        var user = CurrentUser();
        return Ok(coordinator.GetCatalog(itemId, user, HttpContext.RequestAborted));
    });

    [HttpPost("Preview")]
    [Consumes("application/json")]
    [RequestSizeLimit(32 * 1024)]
    public IActionResult Preview([FromBody] PackageRequest request) => RunSafe(() =>
    {
        var user = CurrentUser();
        return Ok(coordinator.Preview(request, user, HttpContext.RequestAborted));
    });

    [HttpPost("Packages")]
    [Consumes("application/json")]
    [RequestSizeLimit(32 * 1024)]
    public IActionResult CreatePackage([FromBody] PackageRequest request) => RunSafe(() =>
    {
        var user = CurrentUser();
        var created = coordinator.Create(request, user, HttpContext.RequestAborted);
        return StatusCode(StatusCodes.Status201Created, created);
    });

    [HttpGet("Preferences")]
    [RequestSizeLimit(1024)]
    public async Task<IActionResult> GetPreferences(CancellationToken cancellationToken) =>
        await RunSafeAsync(async () =>
        {
            var user = CurrentUser();
            return Ok(await preferences.GetAsync(user.Id, cancellationToken).ConfigureAwait(false));
        }).ConfigureAwait(false);

    [HttpPut("Preferences")]
    [Consumes("application/json")]
    [RequestSizeLimit(4096)]
    public async Task<IActionResult> SavePreferences([FromBody] UserPreferencesDto value, CancellationToken cancellationToken) =>
        await RunSafeAsync(async () =>
        {
            var user = CurrentUser();
            return Ok(await preferences.SaveAsync(user.Id, value, cancellationToken).ConfigureAwait(false));
        }).ConfigureAwait(false);

    [HttpGet("Jobs")]
    [RequestSizeLimit(1024)]
    public IActionResult GetJobs() => RunSafe(() => Ok(coordinator.GetJobs(CurrentUser())));

    [HttpGet("Jobs/{jobId:guid}")]
    [RequestSizeLimit(1024)]
    public IActionResult GetJob(Guid jobId) => RunSafe(() => Ok(coordinator.GetJob(jobId, CurrentUser())));

    [HttpDelete("Jobs/{jobId:guid}")]
    [RequestSizeLimit(1024)]
    public IActionResult CancelJob(Guid jobId) => RunSafe(() => Ok(coordinator.Cancel(jobId, CurrentUser())));

    [HttpPost("Jobs/{jobId:guid}/Retry")]
    [RequestSizeLimit(1024)]
    public IActionResult RetryJob(Guid jobId) => RunSafe(() =>
    {
        var user = CurrentUser();
        return StatusCode(StatusCodes.Status201Created, coordinator.Retry(jobId, user, HttpContext.RequestAborted));
    });

    [HttpPost("Download")]
    [AllowAnonymous]
    [Consumes("application/x-www-form-urlencoded")]
    [RequestSizeLimit(1024)]
    public async Task<IActionResult> Download(CancellationToken requestAborted)
    {
        Response.Headers.CacheControl = "no-store";
        Response.Headers.Pragma = "no-cache";
        if (!Request.HasFormContentType || Request.ContentLength is > 1024)
        {
            return DownloadError(StatusCodes.Status400BadRequest, new ErrorDto("ticketUnavailable", "This download ticket is unavailable."));
        }

        DownloadLease? lease = null;
        var finished = false;
        try
        {
            var form = await Request.ReadFormAsync(requestAborted).ConfigureAwait(false);
            if (form.Count != 1 || form["ticket"].Count != 1 || form["ticket"].ToString().Length > 128)
            {
                throw new ZipperException("ticketUnavailable", "This download ticket is expired or already used.", 410);
            }

            lease = coordinator.ConsumeTicket(form["ticket"].ToString(), requestAborted, applicationLifetime.ApplicationStopping);
            var user = authorization.GetAuthorizedUser(lease.OwnerId);
            var package = coordinator.Revalidate(lease, user);

            Response.StatusCode = StatusCodes.Status200OK;
            Response.ContentType = "application/zip";
            Response.Headers.ContentDisposition = AttachmentHeader(package.DownloadFileName);
            Response.Headers.CacheControl = "no-store";
            Response.Headers.Pragma = "no-cache";
            Response.Headers.AcceptRanges = "none";
            Response.Headers.XContentTypeOptions = "nosniff";
            Response.Headers["X-Accel-Buffering"] = "no";

            await writer.WriteAsync(
                package,
                Response.Body,
                bytes => coordinator.AddProgress(lease, bytes, 0),
                bytes => coordinator.AddProgress(lease, 0, bytes),
                lease.CancellationToken).ConfigureAwait(false);

            coordinator.Complete(lease);
            finished = true;
            return new EmptyResult();
        }
        catch (ZipperException exception)
        {
            if (lease is not null)
            {
                coordinator.Fail(lease, exception.Message);
                finished = true;
            }

            if (Response.HasStarted)
            {
                HttpContext.Abort();
                return new EmptyResult();
            }

            return DownloadError(exception.StatusCode, new ErrorDto(exception.Code, exception.Message));
        }
        catch (OperationCanceledException)
        {
            if (lease is not null)
            {
                coordinator.Cancelled(lease);
                finished = true;
            }

            if (Response.HasStarted)
            {
                HttpContext.Abort();
                return new EmptyResult();
            }

            return DownloadError(499, new ErrorDto("downloadCancelled", "The package download was cancelled."));
        }
        catch (IOException) when (requestAborted.IsCancellationRequested || lease?.CancellationToken.IsCancellationRequested == true)
        {
            if (lease is not null)
            {
                coordinator.Cancelled(lease);
                finished = true;
            }

            if (Response.HasStarted)
            {
                HttpContext.Abort();
                return new EmptyResult();
            }

            return DownloadError(499, new ErrorDto("downloadCancelled", "The package download was cancelled."));
        }
        catch (IOException)
        {
            if (lease is not null)
            {
                coordinator.Fail(lease, "The package transfer was interrupted.");
                finished = true;
                logger.LogWarning("Zipper package transfer was interrupted for job {JobId}.", lease.JobId);
            }

            if (Response.HasStarted)
            {
                HttpContext.Abort();
                return new EmptyResult();
            }

            return DownloadError(500, new ErrorDto("transferInterrupted", "The package transfer was interrupted."));
        }
        catch (Exception exception)
        {
            if (lease is not null)
            {
                coordinator.Fail(lease, "The package stream failed.");
                finished = true;
                logger.LogError("Zipper package stream failed for job {JobId} with {ExceptionType}.", lease.JobId, exception.GetType().Name);
            }
            else
            {
                logger.LogWarning("Zipper download request failed with {ExceptionType}.", exception.GetType().Name);
            }

            if (Response.HasStarted)
            {
                HttpContext.Abort();
                return new EmptyResult();
            }

            return DownloadError(500, new ErrorDto("internalError", "The package download could not be started."));
        }
        finally
        {
            if (lease is not null && !finished)
            {
                coordinator.Fail(lease, "The package stream did not complete.");
            }
        }
    }

    private User CurrentUser() => authorization.GetCurrentUser(User);

    private IActionResult RunSafe(Func<IActionResult> action)
    {
        try
        {
            return action();
        }
        catch (ZipperException exception)
        {
            return StatusCode(exception.StatusCode, new ErrorDto(exception.Code, exception.Message));
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499, new ErrorDto("requestCancelled", "The request was cancelled."));
        }
        catch (Exception exception)
        {
            logger.LogError("Zipper API request failed with {ExceptionType}.", exception.GetType().Name);
            return StatusCode(500, new ErrorDto("internalError", "The Zipper request could not be completed."));
        }
    }

    private async Task<IActionResult> RunSafeAsync(Func<Task<IActionResult>> action)
    {
        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (ZipperException exception)
        {
            return StatusCode(exception.StatusCode, new ErrorDto(exception.Code, exception.Message));
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499, new ErrorDto("requestCancelled", "The request was cancelled."));
        }
        catch (Exception exception)
        {
            logger.LogError("Zipper API request failed with {ExceptionType}.", exception.GetType().Name);
            return StatusCode(500, new ErrorDto("internalError", "The Zipper request could not be completed."));
        }
    }

    private static string AttachmentHeader(string downloadFileName)
    {
        var header = new ContentDispositionHeaderValue("attachment")
        {
            FileName = "package.zip",
            FileNameStar = downloadFileName
        };

        return header.ToString();
    }

    private IActionResult DownloadError(int statusCode, ErrorDto error)
    {
        ClearDownloadHeaders();
        return new JsonResult(error)
        {
            StatusCode = statusCode,
            ContentType = "application/json; charset=utf-8"
        };
    }

    private void ClearDownloadHeaders()
    {
        Response.Headers.Remove("Content-Disposition");
        Response.Headers.Remove("Accept-Ranges");
        Response.Headers.Remove("Content-Range");
        Response.Headers.Remove("Content-Length");
        Response.ContentType = null;
    }
}

[ApiController]
[AllowAnonymous]
[Route("Zipper")]
public sealed class ZipperAssetsController : ControllerBase
{
    [HttpGet("zipper.js")]
    public IActionResult GetScript() => EmbeddedAsset("Jellyfin.Plugin.Zipper.Web.zipper.js", "text/javascript; charset=utf-8");

    [HttpGet("zipper.i18n.js")]
    public IActionResult GetLocalizationScript() => EmbeddedAsset("Jellyfin.Plugin.Zipper.Web.zipper.i18n.js", "text/javascript; charset=utf-8");

    [HttpGet("zipper.css")]
    public IActionResult GetStyles() => EmbeddedAsset("Jellyfin.Plugin.Zipper.Web.zipper.css", "text/css; charset=utf-8");

    [HttpGet("Locales/{language}")]
    public IActionResult GetLocale(string language)
    {
        var resource = language switch
        {
            "de" => "Jellyfin.Plugin.Zipper.Web.locales.de.json",
            "en" => "Jellyfin.Plugin.Zipper.Web.locales.en.json",
            "es" => "Jellyfin.Plugin.Zipper.Web.locales.es.json",
            "fr" => "Jellyfin.Plugin.Zipper.Web.locales.fr.json",
            "it" => "Jellyfin.Plugin.Zipper.Web.locales.it.json",
            "ja" => "Jellyfin.Plugin.Zipper.Web.locales.ja.json",
            "ko" => "Jellyfin.Plugin.Zipper.Web.locales.ko.json",
            "nl" => "Jellyfin.Plugin.Zipper.Web.locales.nl.json",
            "pl" => "Jellyfin.Plugin.Zipper.Web.locales.pl.json",
            "pt" => "Jellyfin.Plugin.Zipper.Web.locales.pt.json",
            "ru" => "Jellyfin.Plugin.Zipper.Web.locales.ru.json",
            "zh" => "Jellyfin.Plugin.Zipper.Web.locales.zh.json",
            _ => null
        };
        return resource is null ? NotFound() : EmbeddedAsset(resource, "application/json; charset=utf-8");
    }

    private IActionResult EmbeddedAsset(string name, string contentType)
    {
        var stream = typeof(ZipperAssetsController).Assembly.GetManifestResourceStream(name);
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public,max-age=86400";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(stream, contentType, enableRangeProcessing: false);
    }
}
