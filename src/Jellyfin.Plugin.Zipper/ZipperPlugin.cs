using Jellyfin.Plugin.Zipper.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Zipper;

public sealed class ZipperPlugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginGuid = Guid.Parse("78e5c3be-072f-4ea5-8c49-01d6f61a50ad");

    public ZipperPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        Configuration.Normalize();
    }

    public static ZipperPlugin Instance { get; private set; } = null!;

    public override Guid Id => PluginGuid;
    public override string Name => "Zipper";
    public override string Description => "Create streaming ZIP packages from Jellyfin media and its associated external subtitles.";

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        if (configuration is PluginConfiguration zipperConfiguration)
        {
            zipperConfiguration.Normalize();
        }

        base.UpdateConfiguration(configuration);
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            DisplayName = Name,
            EmbeddedResourcePath = "Jellyfin.Plugin.Zipper.Configuration.config.html",
            EnableInMainMenu = true,
            MenuIcon = "archive"
        };
    }
}

public sealed class ZipperServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost applicationHost)
    {
        services.AddSingleton<ZipperAuthorizationService>();
        services.AddSingleton<UserPreferencesStore>();
        services.AddSingleton<PackageResolver>();
        services.AddSingleton<StreamingZipWriter>();
        services.AddSingleton<PackageCoordinator>();
        services.AddSingleton<IScheduledTask, StartupService>();
    }
}
