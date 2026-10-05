using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Zipper.Helpers;

public sealed class PatchRequestPayload
{
    [JsonPropertyName("contents")]
    public string? Contents { get; set; }
}
