using System.Reflection;
using System.Runtime.Loader;
using Jellyfin.Plugin.Zipper.Helpers;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.Zipper.Services;

public sealed class StartupService(ILogger<StartupService> logger) : IScheduledTask
{
    private static readonly Guid IndexHtmlTransformationId = Guid.Parse("a762c191-2c64-44ec-a4db-79a448d9f901");

    public string Name => "Zipper Startup";
    public string Key => "Jellyfin.Plugin.Zipper.Startup";
    public string Description => "Registers Zipper's optional Jellyfin Web integration.";
    public string Category => "Startup Services";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var transformationAssembly = AssemblyLoadContext.All
                .SelectMany(context => context.Assemblies)
                .FirstOrDefault(assembly => assembly.GetName().Name?.Contains(".FileTransformation", StringComparison.Ordinal) == true);

            if (transformationAssembly is null)
            {
                logger.LogWarning("Zipper's Jellyfin Web actions are disabled because File Transformation 3.0.1 or newer is not installed and enabled.");
                return Task.CompletedTask;
            }

            var pluginInterface = transformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            var register = pluginInterface?.GetMethod(
                "RegisterTransformation",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: [typeof(JObject)],
                modifiers: null);

            if (register is null || register.ReturnType != typeof(void))
            {
                logger.LogWarning("Zipper could not use the installed File Transformation API. Update it to version 3.0.1 or newer to enable the Web actions.");
                return Task.CompletedTask;
            }

            TryRemoveOwnRegistration(pluginInterface!);
            var registration = new JObject
            {
                ["id"] = IndexHtmlTransformationId,
                ["fileNamePattern"] = "index.html",
                ["callbackAssembly"] = GetType().Assembly.FullName,
                ["callbackClass"] = typeof(TransformationPatches).FullName,
                ["callbackMethod"] = nameof(TransformationPatches.IndexHtml)
            };

            register.Invoke(null, [registration]);
            logger.LogInformation("Zipper registered its Jellyfin Web action integration.");
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning("Zipper could not register its Web integration ({ExceptionType}); Jellyfin Web will remain unchanged.", exception.GetType().Name);
        }

        return Task.CompletedTask;
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
    }

    private void TryRemoveOwnRegistration(Type pluginInterface)
    {
        foreach (var methodName in new[] { "RemoveTransformation", "UnregisterTransformation" })
        {
            var remove = pluginInterface.GetMethod(
                methodName,
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: [typeof(Guid)],
                modifiers: null);
            if (remove is null)
            {
                continue;
            }

            try
            {
                remove.Invoke(null, [IndexHtmlTransformationId]);
            }
            catch (Exception exception)
            {
                logger.LogDebug("Zipper could not remove its prior Web transformation ({ExceptionType}); registration will continue.", exception.GetType().Name);
            }

            return;
        }
    }
}
