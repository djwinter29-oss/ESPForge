using ESPForge;
using System.Text.Json;
using System.Text.Json.Nodes;

string? device = null;
bool demo = false;
int port = 8002;
for (int i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--demo": demo = true; break;
        case "--device" when i + 1 < args.Length: device = args[++i]; break;
        case "--port" when i + 1 < args.Length && int.TryParse(args[i + 1], out port): i++; break;
        default: Console.Error.WriteLine("Usage: ESPForge (--device PORT | --demo) [--port 8002]"); return 1;
    }
}
if ((device is null && !demo) || (device is not null && demo) || port is < 1 or > 65535)
{
    Console.Error.WriteLine("Choose exactly one of --device or --demo, and a port from 1-65535.");
    return 1;
}

BoardClient? client;
try { client = device is null ? null : new BoardClient(device); }
catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
{
    Console.Error.WriteLine($"Serial startup failed: {error.Message}");
    return 1;
}
using (client)
{
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = [], ContentRootPath = AppContext.BaseDirectory, WebRootPath = "wwwroot"
    });
    builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
    builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 2048);
    var app = builder.Build();
    app.Use(async (context, next) =>
    {
        var host = context.Request.Host.Value;
        var allowedHosts = new[] { $"127.0.0.1:{port}", $"localhost:{port}" };
        var origin = context.Request.Headers.Origin.ToString();
        if (!allowedHosts.Contains(host) ||
            (origin.Length > 0 && !allowedHosts.Select(h => $"http://{h}").Contains(origin)))
        {
            context.Response.StatusCode = 403;
            await context.Response.WriteAsJsonAsync(new { ok = false, message = "Untrusted host or origin" });
            return;
        }
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        await next();
    });
    app.UseDefaultFiles();
    app.UseStaticFiles();
    app.MapGet("/api/host", () => new { name = ".NET", demo });
    app.MapPost("/api/request", async (HttpContext context) =>
    {
        if (context.Request.ContentType?.Split(';')[0].Trim() != "application/json")
            return Results.Json(new { ok = false, message = "JSON content type required" }, statusCode: 415);
        JsonObject request;
        try
        {
            request = await JsonNode.ParseAsync(context.Request.Body) as JsonObject ??
                throw new ProtocolException("JSON object required");
            Protocol.ValidateRequest(request);
        }
        catch (Exception error) when (error is JsonException or ProtocolException)
        {
            return Results.Json(new { ok = false, message = error.Message }, statusCode: 400);
        }
        try
        {
            JsonObject reply;
            if (client is null)
            {
                if (request["op"]!.GetValue<string>() != "status")
                    throw new ProtocolException("Simulated preview does not execute commands");
                reply = new JsonObject { ["id"] = 1, ["ok"] = true, ["status"] = Protocol.DemoStatus() };
            }
            else reply = await Task.Run(() => client.Request(request));
            return Results.Json(reply);
        }
        catch (Exception error) when (error is ProtocolException or IOException or InvalidOperationException or TimeoutException)
        {
            app.Logger.LogWarning("Board request failed: {Message}", error.Message);
            return Results.Json(new { ok = false, message = error.Message }, statusCode: 502);
        }
    });
    Console.WriteLine($"ESPForge .NET{(demo ? " SIMULATED" : "")}: http://127.0.0.1:{port}/");
    await app.RunAsync();
}
return 0;
