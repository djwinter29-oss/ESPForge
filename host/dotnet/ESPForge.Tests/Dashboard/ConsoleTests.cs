// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;

namespace ESPForge.Tests;

public sealed class ConsoleTests
{
    [Fact]
    public async Task ApiValidatesBodiesAndHeaderAndPreservesSameOriginGuard()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var boards = new ConsoleBoards();
        await using var app = await Build(boards, server);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        foreach (var body in new[] { "null", "[]", "{\"ip\":\"127.0.0.1\"}", "{\"board\":\"board-a\"}", "{\"x\":1}" })
            await Error(client, HttpMethod.Post, body, HttpStatusCode.BadRequest);
        foreach (var body in new[]
        {
            "{}", "{\"data\":\"\"}", "{\"data\":12}", "{\"data\":\"!\"}", "{\"data\":\"YQ==\",\"x\":1}",
            "{\"data\":\"YQ==\",\"data\":\"Yg==\"}", "{\"data\":\"" + Convert.ToBase64String(new byte[1025]) + "\"}",
            "{\"data\":\"Y Q==\"}", "{\"data\":\"\\tYQ==\"}", "{\"data\":\"YQ==\\r\\n\"}",
            "{\"data\":\"YQ==\u00a0\"}", "{\"data\":\"ＹQ==\"}", "{\"data\":\"" + new string('A', 1369) + "\"}"
        })
            await Error(client, HttpMethod.Post, body, HttpStatusCode.BadRequest, route: "/api/console/input");
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PostAsJsonAsync("/api/console", new { })).StatusCode);
        Assert.Equal(0, boards.Lookups);
        using (var crossOrigin = new HttpRequestMessage(HttpMethod.Post, "/api/console?board=board-a"))
        {
            crossOrigin.Headers.Add("Origin", "http://foreign.invalid");
            crossOrigin.Content = JsonContent.Create(new { });
            Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(crossOrigin)).StatusCode);
        }
        var opening = client.PostAsJsonAsync("/api/console?board=board-a", new { });
        using var peer = await server.AcceptSocketAsync();
        var response = await opening;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await EchoSetup(peer);
        var sessionJson = await response.Content.ReadFromJsonAsync<JsonElement>();
        var opened = sessionJson.Deserialize<ConsoleSessionResponse>(DashboardJson.Options);
        Assert.NotNull(opened);
        Assert.Equal("127.0.0.1", opened.Ipv4);
        Assert.Matches("^[A-Za-z0-9_-]{16,128}$", opened.Session);
        Assert.Equal(new[] { "ipv4", "session" }, sessionJson
            .EnumerateObject().Select(field => field.Name).Order().ToArray());
        foreach (var route in new[] { "/api/console", "/api/console/input" })
        {
            using var unsupported = await Request(client, HttpMethod.Put, opened.Session,
                "{\"data\":\"YQ==\"}", route);
            Assert.Equal(HttpStatusCode.MethodNotAllowed, unsupported.StatusCode);
        }
        await Error(client, HttpMethod.Post, "{\"data\":\"YQ==\"}", HttpStatusCode.BadRequest, opened.Session);
        await Error(client, HttpMethod.Post, "{\"data\":\"YQ==\"}", HttpStatusCode.Conflict,
            route: "/api/console/input");
        await Error(client, HttpMethod.Post, "{\"data\":\"YQ==\"}", HttpStatusCode.Conflict, "wrong",
            "/api/console/input");
        await Error(client, HttpMethod.Post, "{}", HttpStatusCode.Conflict);
        await Error(client, HttpMethod.Get, null, HttpStatusCode.Conflict);
        await Error(client, HttpMethod.Get, null, HttpStatusCode.Conflict, "wrong");
        Assert.Equal(HttpStatusCode.Conflict,
            (await client.GetAsync("/api/console?session=not-a-header-token")).StatusCode);
        var reading = Request(client, HttpMethod.Get, opened.Session);
        // A pending two-second GET must not block input or DELETE.
        var payload = Enumerable.Range(0, 1024).Select(index => (byte)index).ToArray();
        using var writing = await Request(client, HttpMethod.Post, opened.Session,
            JsonSerializer.Serialize(new { data = Convert.ToBase64String(payload) }), "/api/console/input")
            .WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.OK, writing.StatusCode);
        var writtenJson = await writing.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1024, writtenJson.GetProperty("written").GetInt32());
        Assert.Equal(new[] { "written" }, writtenJson
            .EnumerateObject().Select(field => field.Name).ToArray());
        var received = new byte[1024];
        var count = 0;
        while (count < received.Length)
            count += await peer.ReceiveAsync(received.AsMemory(count), SocketFlags.None);
        Assert.Equal(payload, received);
        await peer.SendAsync(new byte[] { 0, 255, 13, 10 }, SocketFlags.None);
        var output = await reading;
        Assert.Equal(HttpStatusCode.OK, output.StatusCode);
        var readJson = await output.Content.ReadFromJsonAsync<JsonElement>();
        var read = readJson.Deserialize<ConsoleReadResponse>(DashboardJson.Options)!;
        Assert.Equal(new byte[] { 0, 255, 13, 10 }, Convert.FromBase64String(read.Data));
        Assert.False(read.Closed);
        Assert.Equal(new[] { "closed", "data" }, readJson
            .EnumerateObject().Select(field => field.Name).Order().ToArray());
        var waiting = Request(client, HttpMethod.Get, opened.Session);
        using var close = await Request(client, HttpMethod.Delete, opened.Session).WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.OK, close.StatusCode);
        Assert.Equal("{}", await close.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, (await waiting).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Request(client, HttpMethod.Delete, opened.Session)).StatusCode);
        await Error(client, HttpMethod.Delete, null, HttpStatusCode.Conflict, "wrong");
        await app.StopAsync();
    }

    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("0.1.2.3")]
    [InlineData("127.0.0.1")]
    [InlineData("127.9.8.7")]
    [InlineData("224.0.0.1")]
    [InlineData("239.255.255.255")]
    [InlineData("255.255.255.255")]
    [InlineData("::1")]
    [InlineData("not-an-ip")]
    public async Task ProductionRejectsUnsafeReportedAddresses(string ipv4)
    {
        var boards = new ConsoleBoards();
        boards.MonitorValue.Snapshot = Ready(ipv4);
        using var bridge = new ConsoleBridge(boards);
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.OpenAsync("board-a", default));
    }

    [Theory]
    [InlineData("disconnected")]
    [InlineData("wireless-error")]
    [InlineData("missing-wireless")]
    [InlineData("not-connected")]
    [InlineData("changed-ip")]
    [InlineData("replacement")]
    [InlineData("new-connection")]
    [InlineData("new-monitor")]
    [InlineData("removed")]
    public async Task EveryRequestClosesOnStaleOrReplacedBoard(string state)
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var boards = new ConsoleBoards();
        using var bridge = Bridge(boards, server);
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        var (token, _) = await opening;
        await EchoSetup(peer);
        switch (state)
        {
            case "disconnected": boards.MonitorValue.Snapshot = Ready() with { Connected = false }; break;
            case "wireless-error": boards.MonitorValue.Snapshot = Ready() with { WirelessError = "stale" }; break;
            case "missing-wireless": boards.MonitorValue.Snapshot = Ready() with { Wireless = null }; break;
            case "not-connected": boards.MonitorValue.Snapshot = Ready() with
                { Wireless = new() { WifiEnabled = true, WifiState = WifiState.Testing } }; break;
            case "changed-ip": boards.MonitorValue.Snapshot = Ready("192.168.1.2"); break;
            case "replacement": boards.Board = boards.Board with { DevicePath = "/hid/replacement" }; break;
            case "new-connection": boards.MonitorValue.ConnectionIdentity = new object(); break;
            case "new-monitor": boards.MonitorValue = new TestMonitor { Snapshot = Ready() }; break;
            case "removed": boards.Removed = true; break;
        }
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.WriteAsync(token, [1], default));
        Assert.Equal(0, await peer.ReceiveAsync(new byte[1], SocketFlags.None));
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.ReadAsync(token, default));
        bridge.Close(token);
        Assert.Throws<BoardStateException>(() => bridge.Close("wrong"));
    }

    [Fact]
    public async Task ActualMonitorReconnectInvalidatesSessionEvenWithSameAddress()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        await using var monitor = new DeviceMonitor();
        monitor.Attach(new MonitorCommandTests.Commands(), Ready());
        using var bridge = new ConsoleBridge(new OneBoard(monitor), TimeProvider.System,
            ((IPEndPoint)server.LocalEndpoint).Port, true);
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        var (token, _) = await opening;
        await EchoSetup(peer);
        monitor.HandleDisconnect(new IOException("disconnected"));
        monitor.Attach(new MonitorCommandTests.Commands(), Ready());
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.ReadAsync(token, default));
    }

    [Fact]
    public async Task ReadIsBoundedReportsEofAndDeleteCannotCloseAnotherSession()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var boards = new ConsoleBoards();
        using var bridge = Bridge(boards, server);
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        var (first, _) = await opening;
        await EchoSetup(peer);
        var empty = await bridge.ReadAsync(first, default).WaitAsync(TimeSpan.FromSeconds(4));
        Assert.Empty(empty.Data);
        Assert.False(empty.Closed);
        var data = Enumerable.Repeat((byte)42, 5000).ToArray();
        await peer.SendAsync(data, SocketFlags.None);
        var output = await bridge.ReadAsync(first, default);
        Assert.InRange(output.Data.Length, 1, 4096);
        Assert.False(output.Closed);
        var remaining = await bridge.ReadAsync(first, default);
        Assert.Equal(5000, output.Data.Length + remaining.Data.Length);
        peer.Shutdown(SocketShutdown.Send);
        var eof = await bridge.ReadAsync(first, default);
        Assert.Empty(eof.Data);
        Assert.True(eof.Closed);
        bridge.Close(first);
        opening = bridge.OpenAsync("board-a", default);
        using var next = await server.AcceptSocketAsync();
        var (second, _) = await opening;
        await EchoSetup(next);
        Assert.NotEqual(first, second);
        Assert.Throws<BoardStateException>(() => bridge.Close(first));
        Assert.Equal(1, await bridge.WriteAsync(second, [7], default));
        bridge.Close(second);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PartialAndUncertainWritesAreSentOnlyOnceAndClose(bool fail)
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var calls = 0;
        using var bridge = Bridge(new ConsoleBoards(), server, send: async (socket, data, cancel) =>
        {
            if (data.Span.SequenceEqual("\x03\x03shell echo on\r"u8))
                return await socket.SendAsync(data, SocketFlags.None, cancel);
            calls++;
            var sent = await socket.SendAsync(data[..1], SocketFlags.None, cancel);
            if (fail) throw new SocketException((int)SocketError.ConnectionReset);
            return sent;
        });
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        var (token, _) = await opening;
        await EchoSetup(peer);
        if (fail) await Assert.ThrowsAsync<IOException>(() => bridge.WriteAsync(token, [1, 2, 3], default));
        else Assert.Equal(1, await bridge.WriteAsync(token, [1, 2, 3], default));
        Assert.Equal(1, calls);
        Assert.Equal(1, await peer.ReceiveAsync(new byte[3], SocketFlags.None));
        Assert.Equal(0, await peer.ReceiveAsync(new byte[3], SocketFlags.None));
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.WriteAsync(token, [1, 2, 3], default));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task OpenDiscardsDraftBeforeEchoSetupExactlyOnceAndPreservesShellOutput()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var calls = 0;
        using var bridge = Bridge(new ConsoleBoards(), server, send: async (socket, data, cancel) =>
        {
            calls++;
            Assert.Equal("\x03\x03shell echo on\r"u8.ToArray(), data.ToArray());
            return await socket.SendAsync(data, SocketFlags.None, cancel);
        });
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        await peer.SendAsync("shell banner\r\n"u8.ToArray(), SocketFlags.None);
        var (token, _) = await opening;
        await EchoSetup(peer);
        Assert.Equal(1, calls);
        var (data, closed) = await bridge.ReadAsync(token, default);
        Assert.Equal("shell banner\r\n"u8.ToArray(), data);
        Assert.False(closed);
        bridge.Close(token);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(3, false)]
    [InlineData(3, true)]
    public async Task IncompleteOrUncertainSetupClosesWithoutPublishingOrReplaying(int prefix, bool fail)
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var calls = 0;
        await using var app = await Build(new ConsoleBoards(), server, async (socket, data, cancel) =>
        {
            calls++;
            Assert.Equal("\x03\x03shell echo on\r"u8.ToArray(), data.ToArray());
            var sent = prefix == 0 ? 0 : await socket.SendAsync(data[..prefix], SocketFlags.None, cancel);
            if (fail) throw new SocketException((int)SocketError.ConnectionReset);
            return sent;
        });
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        var opening = client.PostAsJsonAsync("/api/console?board=board-a", new { });
        using var peer = await server.AcceptSocketAsync();
        using var response = await opening;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("setup is uncertain", result.GetProperty("error").GetString());
        Assert.False(result.TryGetProperty("session", out _));
        var actual = new List<byte>();
        var buffer = new byte[16];
        int received;
        while ((received = await peer.ReceiveAsync(buffer, SocketFlags.None)) > 0)
            actual.AddRange(buffer[..received]);
        Assert.Equal("\x03\x03shell echo on\r"u8[..prefix].ToArray(), actual.ToArray());
        Assert.Equal(1, calls);
        await app.StopAsync();
    }

    [Fact]
    public async Task ExpiryUsesRequestTimeAndDisposalClosesSocketAndPendingRead()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var time = new ManualTime();
        using var bridge = Bridge(new ConsoleBoards(), server, time);
        var opening = bridge.OpenAsync("board-a", default);
        using var peer = await server.AcceptSocketAsync();
        var (token, _) = await opening;
        await EchoSetup(peer);
        time.Advance(TimeSpan.FromSeconds(14));
        Assert.Equal(1, await bridge.WriteAsync(token, [7], default));
        Assert.Equal(1, await peer.ReceiveAsync(new byte[1], SocketFlags.None));
        time.Advance(TimeSpan.FromSeconds(14));
        bridge.Expire();
        Assert.Equal(1, await bridge.WriteAsync(token, [8], default));
        Assert.Equal(1, await peer.ReceiveAsync(new byte[1], SocketFlags.None));
        time.Advance(TimeSpan.FromSeconds(15));
        Assert.Equal(0, await peer.ReceiveAsync(new byte[1], SocketFlags.None).WaitAsync(TimeSpan.FromSeconds(4)));
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.ReadAsync(token, default));
        bridge.Close(token);
        opening = bridge.OpenAsync("board-a", default);
        using var next = await server.AcceptSocketAsync();
        (token, _) = await opening;
        await EchoSetup(next);
        var reading = bridge.ReadAsync(token, default);
        bridge.Dispose();
        await Assert.ThrowsAsync<BoardStateException>(() => reading);
        await Closed(next);
        await Assert.ThrowsAsync<BoardStateException>(() => bridge.OpenAsync("board-a", default));
    }

    [Fact]
    public async Task ApplicationDisposalOwnsRelayCleanup()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        await using var app = await Build(new ConsoleBoards(), server);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        var opening = client.PostAsJsonAsync("/api/console?board=board-a", new { });
        using var peer = await server.AcceptSocketAsync();
        Assert.Equal(HttpStatusCode.OK, (await opening).StatusCode);
        await EchoSetup(peer);
        await app.StopAsync();
        await app.DisposeAsync();
        await Closed(peer);
    }

    [Fact]
    public async Task SocketConnectFailureIsExplicitServiceUnavailable()
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        var port = ((IPEndPoint)server.LocalEndpoint).Port;
        server.Stop();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var boards = new ConsoleBoards();
        builder.Services.AddSingleton<IDashboardBoards>(boards);
        builder.Services.AddSingleton(_ => new ConsoleBridge(boards, TimeProvider.System, port, true));
        await using var app = await DashboardApplication.BuildAsync(builder);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        await Error(client, HttpMethod.Post, "{}", HttpStatusCode.ServiceUnavailable);
        await app.StopAsync();
    }

    private static StatusResponse Ready(string ipv4 = "127.0.0.1") => new(true, null, Wireless: new()
    {
        WifiEnabled = true, WifiState = WifiState.Connected, Ipv4 = ipv4, TcpCliStarted = true
    });

    private static ConsoleBridge Bridge(ConsoleBoards boards, TcpListener server, TimeProvider? time = null,
        Func<Socket, ReadOnlyMemory<byte>, CancellationToken, ValueTask<int>>? send = null) =>
        new(boards, time ?? TimeProvider.System, ((IPEndPoint)server.LocalEndpoint).Port, true, send);

    private static Task<WebApplication> Build(ConsoleBoards boards, TcpListener server,
        Func<Socket, ReadOnlyMemory<byte>, CancellationToken, ValueTask<int>>? send = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton<IDashboardBoards>(boards);
        builder.Services.AddSingleton(_ => Bridge(boards, server, send: send));
        return DashboardApplication.BuildAsync(builder);
    }

    private static Task<HttpResponseMessage> Request(HttpClient client, HttpMethod method, string? token,
        string? body = null, string route = "/api/console?board=board-a")
    {
        var request = new HttpRequestMessage(method, route);
        if (token is not null) request.Headers.Add("X-Console-Session", token);
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return client.SendAsync(request);
    }

    private static async Task Error(HttpClient client, HttpMethod method, string? body, HttpStatusCode expected,
        string? token = null, string route = "/api/console?board=board-a")
    {
        using var response = await Request(client, method, token, body, route);
        Assert.Equal(expected, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString();
        Assert.False(string.IsNullOrEmpty(error));
    }

    private static async Task Closed(Socket socket)
    {
        try { Assert.Equal(0, await socket.ReceiveAsync(new byte[1], SocketFlags.None).WaitAsync(TimeSpan.FromSeconds(4))); }
        catch (SocketException error) when (error.SocketErrorCode == SocketError.ConnectionReset) { }
    }

    internal static async Task EchoSetup(Socket socket)
    {
        var expected = "\x03\x03shell echo on\r"u8.ToArray();
        var actual = new byte[expected.Length];
        var count = 0;
        while (count < actual.Length)
        {
            var received = await socket.ReceiveAsync(actual.AsMemory(count), SocketFlags.None)
                .AsTask().WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(received > 0);
            count += received;
        }
        Assert.Equal(expected, actual);
    }

    private sealed class ConsoleBoards : IDashboardBoards
    {
        public DashboardBoard Board = new("board-a", "ESPForge", "uid", "/hid/a");
        public TestMonitor MonitorValue = new() { Snapshot = Ready() };
        public bool Removed;
        public int Lookups;
        public DashboardBoardList Boards() => new(Removed ? [] : [Board], Removed ? null : Board.Id, []);
        public StatusResponse Snapshot(string? id) => Monitor(id).Snapshot;
        public IDeviceMonitor Monitor(string? id)
        {
            Lookups++;
            if (Removed || id != Board.Id) throw new BoardNotFoundException("unknown");
            return MonitorValue;
        }
    }
}
