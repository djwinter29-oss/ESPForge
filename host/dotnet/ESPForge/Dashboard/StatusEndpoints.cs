// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Text.Json;
using System.Text.Json.Serialization;

namespace ESPForge;

internal static class StatusEndpoints
{
    /// <summary>
    /// Requested next-boot clock, SD-card profile and radio enables. <c>confirm_data_loss</c> keeps the shared request
    /// shape; ESPForge has no forced save, so <c>true</c> is refused.
    /// </summary>
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    public sealed record SetSettingsRequest(int? SystemClockMhz,
        [property: JsonPropertyName("sdcard_profile")] int? SdCardProfile, bool ConfirmDataLoss = false,
        int? Radios = null);
    /// <summary>Settings values confirmed by the device after saving.</summary>
    public sealed record SetSettingsResponse(BootSettingsResponse Settings);
    public sealed record CommandResyncRequest(bool Confirm);
    /// <summary>Explicit acknowledgement that the device will reboot and disconnect.</summary>
    public sealed record RebootRequest(bool Confirm);
    /// <summary>Export raw SD blocks, or confirm the OS has ejected before returning to firmware.</summary>
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    public sealed record MscRequest(bool? Enabled, bool ConfirmEjected = false);
    /// <summary>Start authorized temporary-file writes or cancel the admitted run.</summary>
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    public sealed record BenchmarkRequest(bool? Start, int SizeMib = 0, bool Confirm = false);
    /// <summary>An additive RGB colour bitmask, with zero meaning Off.</summary>
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    public sealed record LedRequest([property: JsonNumberHandling(JsonNumberHandling.Strict)] int? Colour);
    /// <summary>Every <c>/api</c> error body, matching the Python server.</summary>
    public sealed record ApiError(string Error);
    /// <summary>Empty success response.</summary>
    public sealed record EmptyResponse;

    /// <summary>Rejects cross-origin non-GET <c>/api</c> requests before routing, matching the Python server.</summary>
    public static IApplicationBuilder UseSameOriginApiWrites(this IApplicationBuilder app)
    {
        return app.Use(async (context, next) =>
        {
            var request = context.Request;
            if (!HttpMethods.IsGet(request.Method) && request.Path.StartsWithSegments("/api") &&
                request.Headers.TryGetValue("Origin", out var origin) && origin != $"{request.Scheme}://{request.Host}")
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(new ApiError("API writes must be same-origin"));
                return;
            }
            await next();
        });
    }

    /// <summary>
    /// Endpoint metadata: the 503 message that replaces transport detail when this endpoint's HID command fails,
    /// matching the Python server's per-endpoint messages.
    /// </summary>
    /// <remarks>
    /// <paramref name="WithDetail"/> appends the transport error and logs it, as the Python console does.
    /// </remarks>
    public sealed record UnavailableMessage(string Message, bool WithDetail = false);

    /// <summary>
    /// The single <c>/api</c> error mapping, matching the Python server; every error body is <c>{error}</c>.
    /// Bad input is 400, an unknown board 404, a board-state conflict or firmware refusal 409, a transport fault or
    /// malformed board data 503, and anything else a logged 500.
    /// </summary>
    public static IApplicationBuilder UseApiErrors(this IApplicationBuilder app)
    {
        var logger = app.ApplicationServices.GetRequiredService<ILoggerFactory>().CreateLogger("ESPForge.Api");
        return app.Use(async (context, next) =>
        {
            try
            {
                await next();
                // Minimal-API body binding may set 413 without throwing through this middleware.
                if (context.Request.Path.StartsWithSegments("/api") &&
                    context.Response.StatusCode == StatusCodes.Status413PayloadTooLarge &&
                    !context.Response.HasStarted)
                    await context.Response.WriteAsJsonAsync(new ApiError("Request body exceeds the allowed size"));
            }
            catch (Exception error) when (!context.Response.HasStarted
                && context.Request.Path.StartsWithSegments("/api")
                && !context.RequestAborted.IsCancellationRequested)
            {
                var unavailable = context.GetEndpoint()?.Metadata.GetMetadata<UnavailableMessage>();
                var (status, message) = error switch
                {
                    BadHttpRequestException bad => (bad.StatusCode, bad.Message),
                    ApiInputException or JsonException => (400, error.Message),
                    BoardNotFoundException => (404, error.Message),
                    BoardStateException => (409, error.Message),
                    WirelessTestCancelledException => (409, error.Message),
                    _ when unavailable is { WithDetail: true } && IsUnavailable(error) =>
                        (503, $"{unavailable.Message}: {error.Message}"),
                    _ when IsUnavailable(error) => (503, unavailable?.Message ?? error.Message),
                    _ => (500, "Internal server error")
                };
                if (status == 500) logger.LogError(error, "Unhandled API error");
                else if (status == 503 && unavailable is { WithDetail: true })
                    logger.LogWarning(error, "{Message}", unavailable.Message);
                context.Response.StatusCode = status;
                await context.Response.WriteAsJsonAsync(new ApiError(message));
            }
        });
    }

    // A request that was not aborted cannot cancel, so OperationCanceledException here is a transport timeout.
    private static bool IsUnavailable(Exception error) => error is IOException or InvalidDataException
        or TimeoutException or UnauthorizedAccessException or System.Net.Sockets.SocketException
        or OperationCanceledException;

    /// <summary>Error statuses a board command can return; every body is <see cref="ApiError"/>.</summary>
    internal static RouteHandlerBuilder Errors(this RouteHandlerBuilder builder, params int[] statusCodes)
    {
        foreach (var statusCode in statusCodes) builder.Produces<ApiError>(statusCode);
        return builder;
    }

    internal static readonly int[] CommandErrors = [400, 404, 409, 413, 503];

    public static IEndpointRouteBuilder MapStatusEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/boards", GetBoards)
            .WithName("GetBoards")
            .WithSummary("Discover attached ESPForge boards")
            .Produces<DashboardBoardList>(StatusCodes.Status200OK)
            .Errors(409, 503);
        endpoints.MapGet("/api/status", GetStatus)
            .WithName("GetDeviceStatus")
            .WithSummary("Get current ESPForge HID status")
            .WithDescription("Returns the selected board's connection state and latest hardware/runtime reports. " +
                "Pass its ID from /api/boards as the board query.")
            .Produces<StatusResponse>(StatusCodes.Status200OK)
            .Errors(404, 409);
        endpoints.MapPost("/api/settings", SetSettings)
            .WithName("SetBootSettings")
            .WithSummary("Save persistent boot settings")
            .WithDescription("Saves supported boot profiles and verifies the HID command result. " +
                "Firmware reboots automatically on success.")
            .Produces<SetSettingsResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        endpoints.MapPost("/api/reboot", Reboot)
            .WithName("RebootDevice")
            .WithSummary("Reboot ESPForge after explicit confirmation")
            .Produces<EmptyResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        endpoints.MapPost("/api/control/resync", ResyncCommand)
            .WithName("ResyncCommandOutcome")
            .WithSummary("Confirm the result of an uncertain HID command")
            .Produces<CommandResyncResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        endpoints.MapPost("/api/msc", SetMsc)
            .WithName("SetUsbStorageOwnership")
            .WithSummary("Export the SD card or return it after confirmed OS eject")
            .Produces<EmptyResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        endpoints.MapPost("/api/benchmark", Benchmark)
            .WithName("StorageBenchmark")
            .WithSummary("Start or cancel the optional temporary-file benchmark")
            .Produces<EmptyResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        endpoints.MapPost("/api/led", Led)
            .WithName("LedColour")
            .WithSummary("Set the onboard RGB LED colour")
            .Produces<EmptyResponse>(StatusCodes.Status200OK)
            .Errors(CommandErrors);
        return endpoints;
    }

    // Endpoints own request shape, so bad input is 400 whatever the board state; the monitor owns board state.
    private static IResult GetBoards(IDashboardBoards dashboard) => Results.Ok(dashboard.Boards());

    private static IResult GetStatus(string? board, IDashboardBoards dashboard) =>
        Results.Ok(dashboard.Snapshot(board));

    private static IResult SetSettings(SetSettingsRequest request, string? board, IDashboardBoards dashboard,
        CancellationToken cancel)
    {
        BootSettingsResponse settings = new(request.SystemClockMhz ?? -1, request.SdCardProfile ?? -1,
            request.Radios ?? -1);
        try { HidProtocol.ValidateSettings(settings); }
        catch (ArgumentException error) { throw new ApiInputException(error.Message); }
        if (request.ConfirmDataLoss) throw new BoardStateException("Forced save is unavailable on ESPForge firmware");
        return Results.Ok(new SetSettingsResponse(dashboard.Monitor(board).SetSettings(settings, cancel)));
    }

    private static IResult Reboot(RebootRequest request, string? board, IDashboardBoards dashboard,
        CancellationToken cancel)
    {
        if (!request.Confirm) throw new ApiInputException("Explicit reboot confirmation is required");
        dashboard.Monitor(board).Reboot(cancel);
        return Results.Ok(new EmptyResponse());
    }

    private static IResult ResyncCommand(CommandResyncRequest request, string? board, IDashboardBoards dashboard,
        CancellationToken cancel)
    {
        if (!request.Confirm) throw new ApiInputException("Explicit confirm: true is required");
        return Results.Ok(dashboard.Monitor(board).ResyncCommand(true, cancel));
    }

    private static IResult Led(LedRequest request, string? board, IDashboardBoards dashboard, CancellationToken cancel)
    {
        if (request.Colour is not { } colour || colour is < 0 or > 7)
            throw new ApiInputException("Expected colour as an RGB bitmask 0..7");
        dashboard.Monitor(board).SetLedColour(colour, cancel);
        return Results.Ok(new EmptyResponse());
    }

    private static IResult Benchmark(BenchmarkRequest request, string? board, IDashboardBoards dashboard,
        CancellationToken cancel)
    {
        if (request.Start is not { } start || (start
                ? !request.Confirm || request.SizeMib is < 1 or > 1024 : request.SizeMib != 0))
            throw new ApiInputException("Confirm file writes with 1..1024 MiB, or cancel with zero size");
        dashboard.Monitor(board).Benchmark(start, request.SizeMib, cancel);
        return Results.Ok(new EmptyResponse());
    }

    private static IResult SetMsc(MscRequest request, string? board, IDashboardBoards dashboard,
        CancellationToken cancel)
    {
        if (request.Enabled is not { } enabled)
            throw new ApiInputException("enabled must be boolean");
        if (!enabled && !request.ConfirmEjected)
            throw new ApiInputException("Safely eject the USB drive and supply confirm_ejected: true");
        dashboard.Monitor(board).SetMsc(enabled, request.ConfirmEjected, cancel);
        return Results.Ok(new EmptyResponse());
    }
}
