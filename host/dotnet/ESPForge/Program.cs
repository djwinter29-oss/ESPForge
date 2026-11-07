// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using ESPForge;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
var port = builder.Configuration.GetValue("port", 8002);
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
await using var app = await DashboardApplication.BuildAsync(builder);
await app.RunAsync();
