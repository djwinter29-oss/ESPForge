// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace ESPForge.Tests;

public sealed class MonitorCommandTests
{
    private static readonly BootSettingsResponse Settings = new(240, 0, 0);

    internal static HardwareInfoResponse Hardware(byte capabilities = 0x8e) =>
        new("ESPForge", "ESP32-S3", 3, "0001020304050607", ProductId: 3, BoardModel: 1, Capabilities: capabilities);

    internal static readonly BoardConfigurationResponse Configuration =
        new(240, 0, 0, 43, 44, [12, 11, 13, 10, 255, 255], 0x04, 0, 255, 255);

    private static DeviceMonitor Attached(IHidCommands commands, StatusResponse status, TimeProvider? time = null)
    {
        var monitor = new DeviceMonitor(() => throw new NotSupportedException(), null, time);
        monitor.Attach(commands, status);
        return monitor;
    }

    internal static StatusResponse Ready(byte capabilities = 0x8e) =>
        new(true, null, Hardware(capabilities), null, null,
            new MemoryStatusResponse(1, true, true, true, false, null, null, null, null, null, null)
                { Msc = new(false, false, false) },
            BoardConfiguration: Configuration) { StorageStale = false };

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public void SaveFlagsPreserveArguments(byte flags)
    {
        var arguments = new byte[64];
        arguments[0] = 240;
        arguments[3] = 1;
        var request = HidProtocol.BuildControlRequest(7, Opcode.SaveSettings, flags, arguments);
        Assert.Equal(69, request.Length);
        Assert.Equal(new byte[] { 20, 1, 7, 5, flags, 240, 0, 0, 1, 0 }, request[..10]);
        Assert.All(request[10..], value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(4)]
    [InlineData(8)]
    [InlineData(128)]
    [InlineData(255)]
    public void SaveRejectsForcedAndReservedFlags(byte flags) =>
        Assert.Throws<ArgumentException>(() =>
            HidProtocol.BuildControlRequest(7, Opcode.SaveSettings, flags, new byte[64]));

    [Fact]
    public void SaveWritesOnceAndReturnsConfirmedSettings()
    {
        var writes = new List<byte[]>();
        var reads = 0;
        using var hid = Hid((report, size) =>
        {
            Assert.Equal(HidProtocol.ControlReportId, report);
            Assert.Equal(HidProtocol.ControlFeatureSize, size);
            return Result(++reads < 2 ? (byte)1 : (byte)2);
        }, writes.Add);
        Assert.Equal(Settings, hid.SetSettings(Settings));
        Assert.Single(writes);
        Assert.Equal(new byte[] { 20, 1, 1, 5, 0, 240, 0, 0, 0, 0 }, writes[0][..10]);
        Assert.False(hid.CommandOutcomeUncertain);
    }

    [Theory]
    [InlineData("replaced")]
    [InlineData("opcode")]
    [InlineData("idle")]
    [InlineData("invalid")]
    [InlineData("settings")]
    [InlineData("profile")]
    public void InvalidSaveResultRemainsUncertainAndBlocksFurtherWrites(string failure)
    {
        var writes = 0;
        var result = Result(2);
        switch (failure)
        {
            case "replaced": result[2] = 2; break;
            case "opcode": result[3] = 2; result.AsSpan(6).Clear(); break;
            case "idle": result = Result(0); result[2] = result[3] = 0; break;
            case "invalid": result[4] = 7; break;
            case "settings": result[6] = 160; break;
            case "profile": result[8] = 1; break;
        }
        using var hid = Hid((_, _) => result, _ => writes++);
        Assert.ThrowsAny<Exception>(() => hid.SetSettings(Settings));
        if (failure is "replaced" or "opcode" or "idle" or "invalid") Assert.True(hid.CommandOutcomeUncertain);
        if (hid.CommandOutcomeUncertain) Assert.Throws<BoardStateException>(() => hid.SetSettings(Settings));
        Assert.Equal(1, writes);
    }

    [Fact]
    public void PendingTimeoutDoesNotReplayAndRemainsUncertain()
    {
        var writes = new List<byte[]>();
        var time = new ManualTime();
        using var hid = Hid((_, _) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(250));
            return Result(1);
        }, writes.Add, time);
        var started = time.GetTimestamp();
        Assert.Throws<TimeoutException>(() => hid.SetSettings(Settings));
        Assert.Equal(TimeSpan.FromMilliseconds(1000), time.GetElapsedTime(started));
        Assert.Single(writes);
        Assert.Equal((byte)0, writes[0][4]);
        Assert.True(hid.CommandOutcomeUncertain);
    }

    [Fact]
    public void SaveDisconnectLeavesOutcomeUncertain()
    {
        var writes = new List<byte[]>();
        using var hid = Hid((_, _) => throw new IOException("detached"), writes.Add);
        Assert.Throws<IOException>(() => hid.SetSettings(Settings));
        Assert.Single(writes);
        Assert.True(hid.CommandOutcomeUncertain);
    }

    [Fact]
    public void MonitorSavesAndRetainsUncertaintyAfterFailure()
    {
        var commands = new Commands();
        using (var monitor = Attached(commands, Ready()))
        {
            Assert.Equal(Settings, monitor.SetSettings(Settings));
            Assert.Equal(Settings, monitor.Snapshot.BoardConfiguration!.NextBoot);
        }
        commands = new Commands { Failure = new TimeoutException("save result unavailable") };
        using var failed = Attached(commands, Ready());
        Assert.Throws<TimeoutException>(() => failed.SetSettings(Settings));
        Assert.True(failed.Snapshot.CommandOutcomeUncertain);
        Assert.Contains("uncertain", failed.Snapshot.Error);
        Assert.Throws<BoardStateException>(() => failed.SetSettings(Settings));
        Assert.Throws<BoardStateException>(() => failed.Reboot());
        Assert.Equal(1, commands.Saves);
    }

    [Fact]
    public void DisconnectedOrUnconfiguredBoardRefusesSaveAndReboot()
    {
        var commands = new Commands();
        using var monitor = new DeviceMonitor();
        foreach (var status in new[] { Ready() with { Connected = false }, Ready() with { BoardConfiguration = null } })
        {
            monitor.Attach(commands, status);
            Assert.True(Record.Exception(() => monitor.SetSettings(Settings)) is BoardStateException or IOException);
        }
        monitor.Attach(commands, Ready() with { Connected = false });
        Assert.True(Record.Exception(() => monitor.Reboot()) is BoardStateException or IOException);
        Assert.Equal(0, commands.Saves);
        Assert.Equal(0, commands.Reboots);
    }

    [Fact]
    public async Task MonitorSurvivesInternalFaultsAndRetries()
    {
        var attempts = 0;
        using var monitor = new DeviceMonitor(() =>
        {
            Interlocked.Increment(ref attempts);
            throw new ArgumentException("parser bug");
        });
        await monitor.StartAsync(CancellationToken.None);
        var deadline = Environment.TickCount64 + 5000;
        while (Volatile.Read(ref attempts) < 2 && Environment.TickCount64 < deadline) await Task.Delay(50);
        await monitor.StopAsync(CancellationToken.None);
        Assert.True(attempts >= 2, "the monitor must keep retrying after a non-device fault");
        Assert.StartsWith("Internal monitor error", monitor.Snapshot.Error);
    }

    [Fact]
    public void SnapshotHidesSectionsThatAgeOutWithoutNewReports()
    {
        var time = new ManualTime();
        var runtime = new RuntimeStatusResponse(1, 1, 240_000_000, true, false, false, null, false, false);
        using var monitor = Attached(new Commands(), Ready() with
        {
            Runtime = runtime,
            Wireless = new(),
            TelemetryStale = false
        }, time);
        Assert.NotNull(monitor.Snapshot.Runtime);
        time.Advance(TimeSpan.FromMilliseconds(749));
        Assert.False(monitor.Snapshot.TelemetryStale);
        Assert.NotNull(monitor.Snapshot.Runtime);
        time.Advance(TimeSpan.FromMilliseconds(1));
        var aged = monitor.Snapshot;
        Assert.Null(aged.Runtime);
        Assert.True(aged.TelemetryStale);
        Assert.NotNull(aged.Memory?.Msc);
        Assert.False(aged.Memory!.Msc!.Enabled);
        time.Advance(TimeSpan.FromMilliseconds(749));
        Assert.False(monitor.Snapshot.StorageStale);
        Assert.NotNull(monitor.Snapshot.Memory);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Null(monitor.Snapshot.Memory);
        Assert.True(monitor.Snapshot.StorageStale);
        Assert.Null(monitor.Snapshot.SelfTest);
        Assert.True(monitor.Snapshot.SelfTestStale);
        time.Advance(TimeSpan.FromMilliseconds(3499));
        Assert.Null(monitor.Snapshot.WirelessError);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal("Wireless status is stale; wait for a fresh report", monitor.Snapshot.WirelessError);
        Assert.NotNull(monitor.Snapshot.Wireless);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancelReachesRunningWifiTestWhileOtherCommandsGetBusy(bool testFinishesFirst)
    {
        var commands = new Commands { TestFinishesBeforeCancelCheck = testFinishesFirst };
        using var monitor = Attached(commands, Ready());
        var test = Task.Run(() => monitor.TestWireless("ESPForge", "secret12"));
        Assert.True(commands.TestStarted.Wait(TimeSpan.FromSeconds(2)));

        var busy = Stopwatch.StartNew();
        Assert.Throws<BoardBusyException>(() => monitor.SetSettings(Settings));
        Assert.InRange(busy.ElapsedMilliseconds, 1500, 5000);
        Assert.Equal(0, commands.Saves);

        var cancel = Stopwatch.StartNew();
        monitor.CancelWirelessTest();
        Assert.True(cancel.ElapsedMilliseconds < 1000, "cancel must not wait for the running test");
        if (testFinishesFirst) Assert.Equal(5, (await test).State);
        else await Assert.ThrowsAsync<WirelessTestCancelledException>(() => test);
        Assert.Equal(1, commands.Cancels);
        Assert.False(monitor.Snapshot.CommandOutcomeUncertain);
    }

    [Fact]
    public void AbortedRequestStopsWaitingWithoutSending()
    {
        var commands = new Commands();
        using var monitor = Attached(commands, Ready());
        var test = Task.Run(() => monitor.TestWireless("ESPForge", "secret12"));
        Assert.True(commands.TestStarted.Wait(TimeSpan.FromSeconds(2)));
        using var aborted = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        Assert.Throws<OperationCanceledException>(() => monitor.SetSettings(Settings, aborted.Token));
        Assert.Equal(0, commands.Saves);
        monitor.CancelWirelessTest();
        Assert.Throws<AggregateException>(() => test.Wait());
    }

    [Fact]
    public void WirelessCancelDeliveryFailureMarksOutcomeUncertain()
    {
        var commands = new Commands
        {
            CancelUncertain = true,
            CancelFailure = new TimeoutException("wireless cancel timed out")
        };
        using var monitor = Attached(commands, Ready());

        Assert.Throws<TimeoutException>(() => monitor.CancelWirelessTest());
        Assert.True(monitor.Snapshot.CommandOutcomeUncertain);
        Assert.Contains("uncertain", monitor.Snapshot.Error);
        Assert.Throws<BoardStateException>(() => monitor.CancelWirelessTest());
    }

    [Fact]
    public async Task HttpRequiresBooleanFieldsAndRefusesForcedSave()
    {
        var commands = new Commands();
        using var monitor = Attached(commands, Ready());
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.ConfigureHttpJsonOptions(options => DashboardJson.Configure(options.SerializerOptions));
        builder.Services.AddOpenApi();
        builder.Services.AddSingleton<IDashboardBoards>(new OneBoard(monitor));
        builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
        await using var app = builder.Build();
        app.UseApiErrors();
        app.UseSameOriginApiWrites();
        app.MapStatusEndpoints();
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        using (var crossOrigin = new HttpRequestMessage(HttpMethod.Post, "/api/reboot?board=board-a"))
        {
            crossOrigin.Headers.Add("Origin", "http://evil.example");
            crossOrigin.Content = new StringContent("{\"confirm\":true}", Encoding.UTF8, "application/json");
            Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(crossOrigin)).StatusCode);
        }

        foreach (var invalid in new object[]
        {
            new { system_clock_mhz = 200, sdcard_profile = 0, radios = 0 },
            new { system_clock_mhz = 240, sdcard_profile = 1, radios = 0 },
            new { system_clock_mhz = 240, sdcard_profile = 0, radios = 4 }
        })
            Assert.Equal(HttpStatusCode.BadRequest,
                (await client.PostAsJsonAsync("/api/settings?board=board-a", invalid)).StatusCode);
        foreach (var invalid in new[] { "null", "1", "\"true\"", "{}", "[]", "" })
        {
            using var body = new StringContent(
                $"{{\"system_clock_mhz\":240,\"sdcard_profile\":0,\"radios\":0,\"confirm_data_loss\":{invalid}}}",
                Encoding.UTF8, "application/json");
            var response = await client.PostAsync("/api/settings?board=board-a", body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.True((await response.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("error", out _));
        }
        var forced = await client.PostAsJsonAsync("/api/settings?board=board-a",
            new { system_clock_mhz = 240, sdcard_profile = 0, radios = 0, confirm_data_loss = true });
        Assert.Equal(HttpStatusCode.Conflict, forced.StatusCode);
        Assert.Contains("Forced save", (await forced.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("error").GetString());
        Assert.Equal(0, commands.Saves);

        var normal = await client.PostAsJsonAsync("/api/settings?board=board-a",
            new { system_clock_mhz = 240, sdcard_profile = 0, radios = 3 });
        Assert.Equal(HttpStatusCode.OK, normal.StatusCode);
        monitor.Attach(commands, Ready());
        var unconfirmed = await client.PostAsJsonAsync("/api/settings?board=board-a",
            new { system_clock_mhz = 80, sdcard_profile = 0, radios = 0, confirm_data_loss = false });
        Assert.Equal(HttpStatusCode.OK, unconfirmed.StatusCode);
        Assert.Equal(2, commands.Saves);
        foreach (var removed in new[] { "/api/led", "/api/msc", "/api/msc/force-return", "/api/self-test" })
        {
            var response = await client.PostAsJsonAsync(removed + "?board=board-a", new { });
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }
        await app.StopAsync();
    }

    private static byte[] Result(byte status)
    {
        var report = new byte[69];
        report[0] = 20;
        report[1] = report[2] = 1;
        report[3] = 5;
        report[4] = status;
        if (status == 2) report[6] = 240;
        return report;
    }

    private static ESPForgeHid Hid(Func<byte, int, byte[]> read, Action<byte[]> write, TimeProvider? time = null) =>
        new(Hardware(), (id, size) => id == 2
            ? [2, 1, 240, 0, 0, 0, 43, 44, 12, 11, 13, 10, 255, 255, 4, 0, 255, 255]
            : read(id, size), write, time);

    internal sealed class Commands : IHidCommands
    {
        public Exception? Failure { get; set; }
        public Exception? CancelFailure { get; set; }
        public bool CancelUncertain { get; set; }
        public int Saves { get; private set; }
        public int Reboots { get; private set; }
        public int Cancels { get; private set; }
        public bool TestFinishesBeforeCancelCheck { get; init; }
        public ManualResetEventSlim TestStarted { get; } = new();
        public bool CommandOutcomeUncertain => Failure is not null || CancelUncertain;
        public ControlCommandReference? UncertainCommand => null;
        public WirelessOperationReference? UncertainWirelessOperation => null;
        public ControlResult? LastCommandResult { get; private set; }
        public CommandResyncResult? ReconcileOutcome(ControlCommandReference? command,
            WirelessOperationReference? wirelessOperation) => null;
        public InputReport? ReadInputReport(int timeoutMilliseconds = 250) =>
            throw new NotSupportedException();
        public BoardConfigurationResponse ReadConfiguration() => throw new NotSupportedException();
        public BootSettingsResponse SetSettings(BootSettingsResponse settings)
        {
            Saves++;
            if (Failure is not null) throw Failure;
            LastCommandResult = new(1, Opcode.SaveSettings, ControlStatus.Completed, ControlError.None, []);
            return settings;
        }
        public void Reboot()
        {
            Reboots++;
            LastCommandResult = new(1, Opcode.Reboot, ControlStatus.Completed, ControlError.None, []);
        }
        public WirelessStatusResponse ReadWireless() => throw new NotSupportedException();
        public WirelessStatusResponse SetWireless(WirelessRequest settings) => throw new NotSupportedException();
        public IReadOnlyList<WirelessNetworkResponse> ScanWireless(Action? onPoll = null) =>
            throw new NotSupportedException();
        // Mirrors ESPForgeHid: the test thread sends the cancel itself, or misses it after its last check.
        public WirelessOperationResponse TestWireless(string ssid, string password, Action? onPoll = null,
            Action<string>? onProgress = null, string? ssidHex = null, CancellationToken cancel = default)
        {
            TestStarted.Set();
            if (!cancel.WaitHandle.WaitOne(TimeSpan.FromSeconds(10))) throw new TimeoutException("never cancelled");
            if (TestFinishesBeforeCancelCheck) return new(5, 5, "192.168.1.2", 0, 1);
            CancelWirelessTest();
            throw new WirelessTestCancelledException();
        }
        public void CancelWirelessTest()
        {
            if (CancelFailure is not null) throw CancelFailure;
            Cancels++;
            LastCommandResult = new(1, Opcode.WifiCancel, ControlStatus.Completed, ControlError.None, []);
        }
    }
}
