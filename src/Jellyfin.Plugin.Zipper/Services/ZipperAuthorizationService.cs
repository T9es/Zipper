using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.Zipper.Services;

public sealed class ZipperAuthorizationService(IUserManager userManager, ILibraryManager libraryManager)
{
    public User GetCurrentUser(ClaimsPrincipal principal)
    {
        if (principal.Identity?.IsAuthenticated != true
            || principal.Claims.Any(claim => claim.Type == "Jellyfin-IsApiKey"
                && string.Equals(claim.Value, "true", StringComparison.OrdinalIgnoreCase))
            || !Guid.TryParse(principal.FindFirstValue("Jellyfin-UserId"), out var userId))
        {
            throw new ZipperException("authenticationRequired", "Sign in with a Jellyfin user account to use Zipper.", 401);
        }

        return GetAuthorizedUser(userId);
    }

    public User GetAuthorizedUser(Guid userId)
    {
        if (!ZipperPlugin.Instance.Configuration.PluginEnabled)
        {
            throw new ZipperException("zipperDisabled", "Zipper is disabled by the server administrator.", 403);
        }

        var user = userManager.GetUserById(userId);
        if (user is null
            || user.HasPermission(PermissionKind.IsDisabled)
            || !user.HasPermission(PermissionKind.EnableContentDownloading))
        {
            throw new ZipperException("downloadNotAllowed", "This Jellyfin account cannot download this content.", 403);
        }

        return user!;
    }

    public BaseItem GetVisibleItem(Guid itemId, User user)
    {
        var item = libraryManager.GetItemById<BaseItem>(itemId, user);
        if (item is null || !item.IsVisibleStandalone(user))
        {
            throw new ZipperException("itemUnavailable", "The selected item is unavailable.", 404);
        }

        return item;
    }

    public BaseItem GetDownloadableItem(Guid itemId, User user)
    {
        var item = GetVisibleItem(itemId, user);
        if (!item.CanDownload(user))
        {
            throw new ZipperException("downloadNotAllowed", "This Jellyfin account cannot download this content.", 403);
        }

        return item;
    }
}
