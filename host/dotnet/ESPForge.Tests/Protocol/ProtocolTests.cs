// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using ESPForge;
using Xunit;

namespace ESPForge.Tests;

public sealed class ProtocolTests
{
    [Fact]
    public void MemoryInventoryDistinguishesCapacityFromReservationAndUnavailableComponents()
    {
        var identityReport = IdentityReport();
        Assert.False(HidProtocol.ParseIdentityReport(identityReport).MemoryReportSupported);
        identityReport[17] = 1;
        var identity = HidProtocol.ParseIdentityReport(identityReport);
        Assert.True(identity.MemoryReportSupported);
        var report = new byte[17]; report[0] = 13; report[1] = 1; report[2] = 3;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(5), 8 << 20);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(9), 1 << 20);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(13), 16 << 20);
        var memory = HidProtocol.ParseMemoryInventory(report, identity);
        Assert.Equal((uint)(8 << 20), memory.PsramTotalBytes);
        Assert.Equal((uint)(1 << 20), memory.PsramReservedBytes);
        Assert.Equal((uint)(16 << 20), memory.FlashTotalBytes);
        foreach (var (offset, value) in new[] { (1, 2), (2, 4), (3, 1), (12, 1), (16, 0) })
        {
            var invalid = (byte[])report.Clone(); invalid[offset] = (byte)value;
            Assert.Throws<InvalidDataException>(() => HidProtocol.ParseMemoryInventory(invalid, identity));
        }
        report.AsSpan(2).Clear();
        Assert.Null(HidProtocol.ParseMemoryInventory(report, identity).PsramTotalBytes);
        Assert.Null(HidProtocol.ParseMemoryInventory(report, identity).FlashTotalBytes);
    }

    [Fact]
    public void RgbColoursAndUnavailableDriverAreValidated()
    {
        var report = new byte[23];
        report[0] = 3; report[1] = 1; report[22] = 8;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(17), 240000000);
        for (byte colour = 0; colour <= 7; colour++)
        {
            report[2] = colour;
            var runtime = HidProtocol.ParseTelemetryReport(report);
            Assert.Equal(colour, runtime.LedColour);
            Assert.Equal(colour != 0, runtime.LedOn);
            var arguments = new byte[64]; arguments[0] = colour;
            Assert.Equal(colour, HidProtocol.BuildControlRequest(7, Opcode.Led, 0, arguments)[5]);
        }
        report[2] = 0; report[22] = 0;
        Assert.Null(HidProtocol.ParseTelemetryReport(report).LedColour);
        report[2] = 4;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseTelemetryReport(report));
        var invalid = new byte[64]; invalid[0] = 8;
        Assert.Throws<ArgumentException>(() => HidProtocol.BuildControlRequest(7, Opcode.Led, 0, invalid));
    }

    [Fact]
    public void BenchmarkCountersRatesAndTerminalFactsAreValidated()
    {
        var report = new byte[33];
        report[0] = 11; report[1] = 1; report[2] = 9; report[3] = 3; report[4] = 3;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(5), 1048576);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(9), 524288);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(17), 500);
        var status = HidProtocol.ParseBenchmarkReport(report);
        Assert.True(status.Active);
        Assert.Equal(25, status.ProgressPercent);
        Assert.Equal(1048576, status.WriteBytesPerSecond);
        Assert.Null(status.ReadBytesPerSecond);
        foreach (var (offset, value) in new[] { (3, 9), (4, 4), (29, 7), (30, 1), (31, 1) })
        {
            var bad = (byte[])report.Clone();
            bad[offset] = (byte)value;
            Assert.Throws<InvalidDataException>(() => HidProtocol.ParseBenchmarkReport(bad));
        }
        report[3] = 6; report[4] = 2;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(9), 1048576);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(13), 1048576);
        Assert.Equal(100, HidProtocol.ParseBenchmarkReport(report).ProgressPercent);
        report[4] |= 1;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseBenchmarkReport(report));
    }

    [Fact]
    public void ParsesIdentityAndBoardConfigurationReports()
    {
        var identity = HidProtocol.ParseIdentityReport(IdentityReport());
        Assert.Equal((ushort)3, identity.ProductId);
        Assert.Equal("ESP32-S3", identity.Mcu);
        Assert.Equal((byte)1, identity.BoardModel);
        Assert.Equal((byte)0x96, identity.Capabilities);
        Assert.True(identity.WirelessSupported);
        Assert.Equal("0001020304050607", identity.SerialNumber);
        Assert.Equal((uint)524288, identity.RamTotalBytes);

        var configuration = HidProtocol.ParseConfigurationReport(ConfigurationReport(), identity);
        Assert.Equal((ushort)240, configuration.StoredSystemClockMhz);
        Assert.Equal((byte)0, configuration.StoredSdCardProfile);
        Assert.Equal((0, 43, 44), (configuration.MonitorUartIndex, configuration.MonitorUartTxGpio,
            configuration.MonitorUartRxGpio));
        Assert.Equal(new byte[] { 12, 11, 13, 14, 15, 10 }, configuration.StorageGpios);
        Assert.Equal((240, 0, 0), (configuration.SystemClockMhz, configuration.SdCardProfile, configuration.Radios));
        Assert.False(configuration.TcpCliEnabled);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(80)]
    [InlineData(160)]
    [InlineData(240)]
    public void ConfigurationAcceptsEveryProfileClock(ushort clock)
    {
        var report = ConfigurationReport();
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(2), clock);
        Assert.Equal(clock, HidProtocol.ParseConfigurationReport(report,
            HidProtocol.ParseIdentityReport(IdentityReport())).StoredSystemClockMhz);
    }

    [Theory]
    [InlineData(2, 2)]
    [InlineData(2, 0)]
    [InlineData(3, 1)]
    [InlineData(18, 0x9e)]
    [InlineData(18, 0x8e)]
    [InlineData(18, 0x86)]
    [InlineData(19, 0)]
    public void RejectsIdentityOutsideTheEspForgeProfile(int index, byte value)
    {
        var report = IdentityReport();
        report[index] = value;
        if (index == 19) report[21] = 0;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseIdentityReport(report));
    }

    [Fact]
    public void BoardModelRequiresEsp32S3AndUnknownMcusAreLabelled()
    {
        var report = IdentityReport();
        report[15] = 2;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseIdentityReport(report));
        report[16] = 0;
        Assert.Equal("Unknown MCU (2)", HidProtocol.ParseIdentityReport(report).Mcu);
    }

    [Theory]
    [InlineData(2, 200)]
    [InlineData(4, 1)]
    [InlineData(14, 0x05)]
    [InlineData(14, 0x06)]
    [InlineData(14, 0x24)]
    [InlineData(8, 49)]
    [InlineData(11, 255)]
    [InlineData(13, 255)]
    public void RejectsConfigurationOutsideTheEspForgeProfile(int index, byte value)
    {
        var report = ConfigurationReport();
        report[index] = value;
        Assert.Throws<InvalidDataException>(() =>
            HidProtocol.ParseConfigurationReport(report, HidProtocol.ParseIdentityReport(IdentityReport())));
    }

    [Fact]
    public void RadioSwitchesRequireWirelessCapability()
    {
        var config = ConfigurationReport();
        config[14] |= HidProtocol.BoardFlagWifi | HidProtocol.BoardFlagBle;
        var radios = HidProtocol.ParseConfigurationReport(config, HidProtocol.ParseIdentityReport(IdentityReport()));
        Assert.Equal((240, 0, 3), (radios.SystemClockMhz, radios.SdCardProfile, radios.Radios));
        var wired = IdentityReport();
        wired[18] &= unchecked((byte)~HidProtocol.CapabilityWireless);
        Assert.Throws<InvalidDataException>(() =>
            HidProtocol.ParseConfigurationReport(config, HidProtocol.ParseIdentityReport(wired)));
    }

    [Fact]
    public void ParsesTelemetryAndValidatesSentinels()
    {
        var report = new byte[HidProtocol.TelemetryPayloadSize + 1];
        report[0] = HidProtocol.TelemetryReportId;
        report[1] = 1;
        BinaryPrimitives.WriteInt16LittleEndian(report.AsSpan(3), 2534);
        BinaryPrimitives.WriteUInt64LittleEndian(report.AsSpan(5), 9_876_543_210);
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(13), 10000);
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(15), ushort.MaxValue);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(17), 240_000_000);
        report[21] = 7;
        report[22] = 0x05;

        var telemetry = HidProtocol.ParseTelemetryReport(report);
        Assert.Equal(9_876_543_210ul, telemetry.UptimeMilliseconds);
        Assert.Equal((ushort)10000, telemetry.CpuUsageCore0BasisPoints);
        Assert.Null(telemetry.CpuUsageCore1BasisPoints);
        Assert.Equal((short)2534, telemetry.TemperatureCentidegrees);

        report[15] = 0xfe;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseTelemetryReport(report));
    }

    [Fact]
    public void ParsesSdmmcStorageStatusWithoutCidOrMsc()
    {
        var hardware = HidProtocol.ParseIdentityReport(IdentityReport());
        var report = StorageReport();
        var result = HidProtocol.ParseStorageReport(report, hardware);
        Assert.Null(result.Runtime);
        Assert.Equal("sdmmc", result.Memory!.Mode);
        Assert.Equal((byte)1, result.Memory.SpeedMode);
        Assert.Equal((uint)25_000_000, result.Memory.BusClockHz);
        Assert.Equal((ulong)2_097_152, result.Memory.CapacityBytes);
        Assert.Equal("fat32", result.Memory.FilesystemFormat);
        Assert.Null(result.Memory.Manufacturer);
        Assert.False(result.Memory.Msc!.Enabled);

        var mountFailed = new byte[report.Length];
        mountFailed[0] = HidProtocol.StorageReportId;
        mountFailed[1] = 1;
        mountFailed[3] = 0x41;
        var failed = HidProtocol.ParseStorageReport(mountFailed, hardware).Memory!;
        Assert.True(failed.SampleValid);
        Assert.False(failed.Initialized);
        Assert.False(failed.PresenceKnown);
        Assert.Null(failed.Mode);
        Assert.Null(failed.BusClockHz);

        foreach (var index in new[] { 32, 33 })
        {
            var msc = StorageReport();
            msc[index] = 1;
            Assert.Throws<InvalidDataException>(() => HidProtocol.ParseStorageReport(msc, hardware));
        }
        foreach (var mode in new byte[] { 1, 2 })
        {
            var legacy = StorageReport();
            legacy[5] = mode;
            Assert.Throws<InvalidDataException>(() => HidProtocol.ParseStorageReport(legacy, hardware));
        }
    }

    [Fact]
    public void SharedJsonOptionsKeepWirelessStatesAsSnakeCaseStrings()
    {
        var json = JsonSerializer.SerializeToElement(new WirelessStatusResponse
        {
            WifiState = WifiState.TestJoined,
            BleState = BleState.Advertising,
            ScanState = (byte)WirelessScanState.Scanning
        }, DashboardJson.Options);
        Assert.Equal("test_joined", json.GetProperty("wifi_state").GetString());
        Assert.Equal("advertising", json.GetProperty("ble_state").GetString());
        Assert.Equal((byte)WirelessScanState.Scanning, json.GetProperty("scan_state").GetByte());
    }

    [Fact]
    public void SharedJsonOptionsRequireAllBoardSettingsConstructorFields()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<BootSettingsResponse>(
            """{"system_clock_mhz":240,"sdcard_profile":0}""", DashboardJson.Options));
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(240, 0, 3)]
    [InlineData(80, 0, 1)]
    public void SettingsEncoderRoundTripsThroughTheSaveResult(int clock, int profile, int radios)
    {
        var arguments = HidProtocol.EncodeSettings(new(clock, profile, radios));
        var report = new byte[HidProtocol.ControlFeatureSize];
        report[0] = HidProtocol.ControlReportId;
        report[1] = report[2] = 1;
        report[3] = (byte)Opcode.SaveSettings;
        report[4] = 2;
        arguments.AsSpan(0, 4).CopyTo(report.AsSpan(6));
        report[10] = 3;
        var result = HidProtocol.ParseControlResult(report);
        Assert.Equal(clock, BinaryPrimitives.ReadUInt16LittleEndian(result.ResultData));
        Assert.Equal(profile, result.ResultData[2]);
        Assert.Equal(radios, result.ResultData[3]);
        Assert.True(HidProtocol.SettingsConfirmed(result, arguments, 3));
        Assert.False(HidProtocol.SettingsConfirmed(result, arguments, 0));
        arguments[3] ^= 1;
        Assert.False(HidProtocol.SettingsConfirmed(result, arguments, 3));
    }

    [Theory]
    [InlineData(100, 0, 0)]
    [InlineData(200, 0, 0)]
    [InlineData(250, 0, 0)]
    [InlineData(240, 1, 0)]
    [InlineData(240, 0, 4)]
    [InlineData(240, 0, -1)]
    public void SettingsValidationRejectsValuesFirmwareRefuses(int clock, int profile, int radios) =>
        Assert.Throws<ArgumentException>(() => HidProtocol.ValidateSettings(new(clock, profile, radios)));

    [Fact]
    public void BuildsAndValidatesControlTransactionResults()
    {
        var arguments = new byte[64];
        arguments[0] = 240;
        arguments[3] = 3;
        var request = HidProtocol.BuildControlRequest(7, Opcode.SaveSettings, 0, arguments);
        Assert.Equal(69, request.Length);
        Assert.Equal(new byte[] { 20, 1, 7, 5, 0, 240, 0, 0, 3, 0 }, request[..10]);
        Assert.All(request[10..], value => Assert.Equal(0, value));

        var result = new byte[HidProtocol.ControlPayloadSize + 1];
        result[0] = HidProtocol.ControlReportId;
        result[1] = 1;
        result[2] = 7;
        result[3] = 5;
        result[4] = 2;
        result[6] = 240;
        var parsed = HidProtocol.ParseControlResult(result);
        HidProtocol.RequireCompleted(parsed, 7, Opcode.SaveSettings);
        Assert.Equal((byte)240, parsed.ResultData[0]);
        result[9] = 3;
        Assert.Equal((byte)3, HidProtocol.ParseControlResult(result).ResultData[3]);
        result[9] = 7;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseControlResult(result));
        result[9] = 0;
        result[8] = 1;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseControlResult(result));
        result[8] = 0;
        result[6] = 200;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseControlResult(result));
        result[6] = 240;

        result[4] = 4;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseControlResult(result));
    }

    [Fact]
    public async Task SettingsAreSavedSeparatelyFromConfirmedReboot()
    {
        var monitor = new EndpointMonitor();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.ConfigureHttpJsonOptions(options => DashboardJson.Configure(options.SerializerOptions));
        builder.Services.AddOpenApi();
        builder.Services.AddSingleton<IDashboardBoards>(new OneBoard(monitor));
        await using var app = builder.Build();
        app.UseApiErrors();
        app.MapStatusEndpoints();
        app.MapOpenApi();
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };

        var saved = await client.PostAsJsonAsync("/api/settings?board=board-a",
            new { system_clock_mhz = 240, sdcard_profile = 0, radios = 0 });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal(new BootSettingsResponse(240, 0, 0), monitor.LastSettings);
        Assert.False(monitor.RebootRequested);

        var unconfirmed = await client.PostAsJsonAsync("/api/reboot?board=board-a", new { confirm = false });
        Assert.Equal(HttpStatusCode.BadRequest, unconfirmed.StatusCode);
        var reboot = await client.PostAsJsonAsync("/api/reboot?board=board-a", new { confirm = true });
        Assert.Equal(HttpStatusCode.OK, reboot.StatusCode);
        Assert.True(monitor.RebootRequested);
        var unconfirmedResync = await client.PostAsJsonAsync("/api/control/resync?board=board-a",
            new { confirm = false });
        Assert.Equal(HttpStatusCode.BadRequest, unconfirmedResync.StatusCode);
        var resync = await client.PostAsJsonAsync("/api/control/resync?board=board-a", new { confirm = true });
        Assert.Equal(HttpStatusCode.OK, resync.StatusCode);
        Assert.False((await resync.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("uncertain").GetBoolean());
        var status = await client.GetFromJsonAsync<JsonElement>("/api/status?board=board-a");
        Assert.True(status.GetProperty("command_resync_supported").GetBoolean());

        var unknownStatus = await client.GetAsync("/api/status?board=unknown");
        Assert.Equal(HttpStatusCode.NotFound, unknownStatus.StatusCode);
        Assert.Contains("unknown board", (await unknownStatus.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("error").GetString());
        var unknownSettings = await client.PostAsJsonAsync("/api/settings?board=unknown",
            new { system_clock_mhz = 240, sdcard_profile = 0, radios = 0 });
        Assert.Equal(HttpStatusCode.NotFound, unknownSettings.StatusCode);

        using var openApi = JsonDocument.Parse(await client.GetStringAsync("/openapi/v1.json"));
        Assert.True(openApi.RootElement.GetProperty("paths").GetProperty("/api/status")
            .GetProperty("get").GetProperty("responses").TryGetProperty("404", out _));
        await app.StopAsync();
    }

    [Fact]
    public async Task ApiErrorsMapEveryExceptionToOneErrorBody()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseApiErrors();
        Exception[] errors =
        [
            new ApiInputException("bad input"), new JsonException("bad json"), new BoardNotFoundException("no board"),
            new BoardStateException("busy"), new ArgumentException("bug"), new KeyNotFoundException("bug"),
            new InvalidOperationException("bug"), new NotSupportedException("bug"), new FormatException("bug"),
            new IOException("unplugged"), new InvalidDataException("garbled"), new TimeoutException("slow"),
            new UnauthorizedAccessException("denied"),
            new System.Net.Sockets.SocketException(10061), new OperationCanceledException("gave up"),
            new BoardBusyException(), new NullReferenceException("bug")
        ];
        for (var index = 0; index < errors.Length; index++)
        {
            var error = errors[index];
            app.MapGet($"/api/fail/{index}", () => { throw error; });
        }
        app.MapGet("/api/masked", () => { throw new IOException("raw"); })
            .WithMetadata(new StatusEndpoints.UnavailableMessage("friendly"));
        app.MapGet("/api/masked-timeout", () => { throw new TimeoutException("raw"); })
            .WithMetadata(new StatusEndpoints.UnavailableMessage("too slow"));
        app.MapGet("/api/detail", () => { throw new IOException("refused"); })
            .WithMetadata(new StatusEndpoints.UnavailableMessage("Board connection failed", WithDetail: true));
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };

        int[] expected = [400, 400, 404, 409, 500, 500, 500, 500, 500, 503, 503, 503, 503, 503, 503, 409, 500];
        for (var index = 0; index < errors.Length; index++)
        {
            var response = await client.GetAsync($"/api/fail/{index}");
            Assert.Equal(expected[index], (int)response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(expected[index] == 500 ? "Internal server error" : errors[index].Message,
                body.GetProperty("error").GetString());
        }
        foreach (var (path, message) in new[]
        {
            ("/api/masked", "friendly"), ("/api/masked-timeout", "too slow"),
            ("/api/detail", "Board connection failed: refused")
        })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(503, (int)response.StatusCode);
            Assert.Equal(message, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error")
                .GetString());
        }
        await app.StopAsync();
    }

    private static byte[] IdentityReport()
    {
        var report = new byte[HidProtocol.IdentityPayloadSize + 1];
        report[0] = HidProtocol.IdentityReportId;
        report[1] = 1;
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(2), HidProtocol.FamilyId);
        for (var index = 0; index < 8; index++) report[index + 4] = (byte)index;
        report[12] = 1;
        report[13] = 2;
        report[14] = 3;
        report[15] = HidProtocol.McuEsp32S3;
        report[16] = HidProtocol.BoardEsp32S3DevKitC1;
        report[18] = 0x96;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(19), 524288);
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(23), 100000);
        return report;
    }

    internal static byte[] ConfigurationReport()
    {
        var report = new byte[HidProtocol.ConfigurationPayloadSize + 1];
        report[0] = HidProtocol.ConfigurationReportId;
        report[1] = 1;
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(2), 240);
        report[4] = 0;
        report[5] = 0;
        report[6] = 43;
        report[7] = 44;
        report[8] = 12;
        report[9] = 11;
        report[10] = 13;
        report[11] = 14;
        report[12] = 15;
        report[13] = 10;
        report[14] = HidProtocol.BoardFlagMonitorUart;
        report[15] = 1;
        report[16] = 255;
        report[17] = 255;
        return report;
    }

    private static byte[] StorageReport()
    {
        var report = new byte[HidProtocol.StoragePayloadSize + 1];
        report[0] = HidProtocol.StorageReportId;
        report[1] = 1;
        report[2] = 7;
        report[3] = 0x6f;
        report[4] = 1;
        report[5] = 3;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(6), 25_000_000);
        report[10] = 1;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(11), 4096);
        report[31] = 3;
        return report;
    }

    [Fact]
    public void MscAvailabilityAndOwnershipPreserveTheReportLayout()
    {
        var hardware = HidProtocol.ParseIdentityReport(IdentityReport());
        var config = ConfigurationReport();
        config[14] = 0x45;
        config[17] = 8;
        Assert.Equal(8, HidProtocol.ParseConfigurationReport(config, hardware).CardDetectGpio);
        var owned = new byte[HidProtocol.StoragePayloadSize + 1];
        owned[0] = HidProtocol.StorageReportId;
        owned[1] = owned[3] = owned[32] = 1;
        var memory = HidProtocol.ParseStorageReport(owned, hardware).Memory!;
        Assert.True(memory.Msc!.Enabled);
        Assert.False(memory.SampleValid);
        Assert.False(memory.Initialized);
        Assert.Null(memory.CapacityBytes);
        var invalid = StorageReport();
        invalid[32] = 1;
        Assert.Throws<InvalidDataException>(() => HidProtocol.ParseStorageReport(invalid, hardware));
        var enable = new byte[64];
        enable[0] = 1;
        Assert.Equal(new byte[] { 20, 1, 9, 3, 0, 1 },
            HidProtocol.BuildControlRequest(9, Opcode.Msc, 0, enable)[..6]);
        Assert.Throws<ArgumentException>(() => HidProtocol.BuildControlRequest(9, Opcode.Msc, 0, new byte[64]));
        Assert.All(HidProtocol.BuildControlRequest(10, Opcode.Msc, 1, new byte[64])[5..],
            value => Assert.Equal(0, value));
    }

    private sealed class EndpointMonitor : TestMonitor
    {
        public BootSettingsResponse? LastSettings { get; private set; }
        public bool RebootRequested { get; private set; }
        public override StatusResponse Snapshot { get; set; } = new(true, null, null, null, null, null,
            BoardConfiguration: MonitorCommandTests.Configuration);
        public override BootSettingsResponse SetSettings(BootSettingsResponse settings,
            CancellationToken cancel = default) => LastSettings = settings;
        public override void Reboot(CancellationToken cancel = default) => RebootRequested = true;
    }
}
