// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Text.Json;

namespace ESPForge;

public sealed record ConsoleSessionResponse(string Session, string Ipv4);
public sealed record ConsoleReadResponse(string Data, bool Closed);
public sealed record ConsoleWriteResponse(int Written);

internal static class ConsoleEndpoints
{
    public static IEndpointRouteBuilder MapConsoleEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var unavailable = new StatusEndpoints.UnavailableMessage(
            "TCP shell connection failed; input may have been partially written, do not replay it");
        endpoints.MapPost("/api/console", async (JsonElement payload, string? board, ConsoleBridge bridge,
            CancellationToken cancel) =>
        {
            if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Any())
                throw new ApiInputException("Expected an empty object");
            var (session, ipv4) = await bridge.OpenAsync(board, cancel);
            return Results.Ok(new ConsoleSessionResponse(session, ipv4));
        }).Errors(400, 409, 413, 503).WithMetadata(new StatusEndpoints.UnavailableMessage(
            "TCP shell connection or echo setup failed; setup is uncertain, do not replay it"));
        endpoints.MapGet("/api/console", async (HttpRequest request, ConsoleBridge bridge, CancellationToken cancel) =>
        {
            var (data, closed) = await bridge.ReadAsync(Token(request), cancel);
            return Results.Ok(new ConsoleReadResponse(Convert.ToBase64String(data), closed));
        }).Errors(409, 503).WithMetadata(unavailable);
        endpoints.MapPost("/api/console/input", async (JsonElement payload, HttpRequest request, ConsoleBridge bridge,
            CancellationToken cancel) =>
        {
            if (payload.ValueKind != JsonValueKind.Object || payload.EnumerateObject().Count() != 1 ||
                !payload.TryGetProperty("data", out var field) || field.ValueKind != JsonValueKind.String)
                throw new ApiInputException("Expected exactly one base64 data string");
            var encoded = field.GetString()!;
            if (encoded.Length > 1368) throw new ApiInputException("Input exceeds 1024 bytes");
            if (encoded.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not ('+' or '/' or '=')))
                throw new ApiInputException("Invalid base64 data");
            byte[] data;
            try { data = Convert.FromBase64String(encoded); }
            catch (FormatException) { throw new ApiInputException("Invalid base64 data"); }
            if (data.Length is < 1 or > 1024) throw new ApiInputException("Expected 1..1024 input bytes");
            return Results.Ok(new ConsoleWriteResponse(await bridge.WriteAsync(Token(request), data, cancel)));
        }).Errors(400, 409, 413, 503).WithMetadata(unavailable);
        endpoints.MapDelete("/api/console", (HttpRequest request, ConsoleBridge bridge) =>
        {
            bridge.Close(Token(request));
            return Results.Ok(new StatusEndpoints.EmptyResponse());
        }).Errors(409);
        return endpoints;
    }

    private static string? Token(HttpRequest request) =>
        request.Headers["X-Console-Session"] is { Count: 1 } values ? values[0] : null;
}
