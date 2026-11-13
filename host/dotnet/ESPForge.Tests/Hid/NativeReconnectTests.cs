// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Buffers.Binary;
using HidSharp;
using Xunit;

namespace ESPForge.Tests;

public sealed class NativeReconnectTests
{
    [Fact]
    public void FeatureReadsNormalizeNativePrefixAndMaximumBufferPadding()
    {
        var device = new Device { FeatureReportLength = HidProtocol.ControlFeatureSize + 16 };
        using var client = new ESPForgeHid(device);
        Assert.Equal(HidProtocol.ParseIdentityReport(IdentityReport()), client.ReadInfo());
        Assert.Equal(new byte[] { 12, 11, 13, 14, 15, 10 }, client.ReadConfiguration().StorageGpios);
        var length = device.FeatureReportLength + (OperatingSystem.IsLinux() ? 1 : 0);
        Assert.Equal(new[] { length, length }, device.Stream.FeatureReadLengths);
    }

    [Theory]
    [InlineData("read-timeout")]
    [InlineData("write-timeout")]
    [InlineData("input-size")]
    [InlineData("feature-size")]
    [InlineData("read")]
    [InlineData("bug")]
    public void InitialSetupFailureClosesTheOpenedStream(string failure)
    {
        var device = new Device { SetupFailure = failure };
        if (failure is "read" or "bug") device.Stream.Identity = () => FailureReport(failure);
        if (failure == "bug") Assert.Throws<ArgumentException>(() => new ESPForgeHid(device));
        else Assert.Throws<IOException>(() => new ESPForgeHid(device));
        Assert.Equal(1, device.Opens);
        Assert.Equal(1, device.Stream.Closes);
    }

    [Theory]
    [InlineData("read-timeout")]
    [InlineData("write-timeout")]
    [InlineData("input-size")]
    [InlineData("feature-size")]
    [InlineData("read")]
    [InlineData("bug")]
    public async Task InitialSetupAndCloseFailureStopsTheMonitorWithoutOpeningAgain(string failure)
    {
        var device = new Device { SetupFailure = failure };
        if (failure is "read" or "bug") device.Stream.Identity = () => FailureReport(failure);
        device.Stream.CloseError = new IOException("initial close failed");
        var monitor = new DeviceMonitor(() => new ESPForgeHid(device));
        try
        {
            monitor.Start();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            while (monitor.Snapshot.Error?.Contains("cleanup failed") != true)
                await Task.Delay(10, timeout.Token);
            Assert.False(monitor.Snapshot.Connected);
            Assert.Throws<BoardStateException>(() => monitor.ResyncCommand(true));
            var shutdown = await Assert.ThrowsAsync<IOException>(() => monitor.DisposeAsync().AsTask());
            var failedOpen = Assert.IsType<HidOpenCleanupException>(shutdown.InnerException);
            var causes = Assert.IsType<AggregateException>(failedOpen.InnerException);
            Assert.Equal(2, causes.InnerExceptions.Count);
            Assert.Equal("initial close failed", causes.InnerExceptions[1].Message);
            Assert.Throws<IOException>(() => failedOpen.Client.Dispose());
            Assert.Equal(1, device.Opens);
            Assert.Equal(1, device.Stream.Closes);
        }
        finally { await Assert.ThrowsAsync<IOException>(() => monitor.DisposeAsync().AsTask()); }
    }

    private static byte[] FailureReport(string failure)
    {
        if (failure == "read") throw new IOException("identity unavailable");
        if (failure == "bug") throw new ArgumentException("identity bug");
        var report = IdentityReport();
        return report;
    }

    private static byte[] IdentityReport()
    {
        var report = new byte[HidProtocol.IdentityFeatureSize];
        report[0] = HidProtocol.IdentityReportId;
        report[1] = 1;
        BinaryPrimitives.WriteUInt16LittleEndian(report.AsSpan(2), HidProtocol.FamilyId);
        for (var index = 0; index < 8; index++) report[index + 4] = (byte)index;
        report[15] = HidProtocol.McuEsp32S3;
        report[16] = HidProtocol.BoardEsp32S3DevKitC1;
        report[18] = 0x96;
        BinaryPrimitives.WriteUInt32LittleEndian(report.AsSpan(19), 524288);
        return report;
    }

    /// <summary>A device whose real HidSharp Open path returns a controlled native-stream substitute.</summary>
    private sealed class Device : HidDevice
    {
        public NativeStream Stream { get; }
        public string? SetupFailure { get; init; }
        public Exception? OpenError { get; set; }
        public int Opens { get; private set; }
        public int FeatureReportLength { get; init; } = HidProtocol.ControlFeatureSize;
        public Device() => Stream = new(this);
        public override int ProductID => HidProtocol.ProductId;
        public override int VendorID => HidProtocol.VendorId;
        public override int ReleaseNumberBcd => 0;
        public override string DevicePath => "/fake/hid";
        public override string GetFileSystemName() => DevicePath;
        public override int GetMaxInputReportLength() => SetupFailure == "input-size"
            ? throw new IOException("input size unavailable") : HidProtocol.StoragePayloadSize + 1;
        public override int GetMaxOutputReportLength() => 0;
        public override int GetMaxFeatureReportLength() => SetupFailure == "feature-size"
            ? throw new IOException("feature size unavailable") : FeatureReportLength;
        protected override DeviceStream OpenDeviceDirectly(OpenConfiguration configuration)
        {
            Opens++;
            if (OpenError is not null) throw OpenError;
            return Stream;
        }
    }

    /// <summary>Counts native writes and closes, including failed closes that must not be retried.</summary>
    private sealed class NativeStream(Device device) : HidStream(device)
    {
        public Func<byte[]> Identity { get; set; } = IdentityReport;
        public Exception? CloseError { get; set; }
        public bool DetachOnWrite { get; set; } = true;
        public int Writes { get; private set; }
        public int Closes { get; private set; }
        public List<int> FeatureReadLengths { get; } = [];
        public override int ReadTimeout
        {
            get;
            set
            {
                if (device.SetupFailure == "read-timeout") throw new IOException("read timeout unavailable");
                field = value;
            }
        }
        public override int WriteTimeout
        {
            get;
            set
            {
                if (device.SetupFailure == "write-timeout") throw new IOException("write timeout unavailable");
                field = value;
            }
        }
        public override void GetFeature(byte[] buffer, int offset, int count)
        {
            var prefix = OperatingSystem.IsLinux() ? 1 : 0;
            if (count != device.GetMaxFeatureReportLength() + prefix)
                throw new IOException("Feature buffer must include native prefix and device maximum report size");
            FeatureReadLengths.Add(count);
            byte[] report;
            if (buffer[offset] == HidProtocol.IdentityReportId) report = Identity();
            else if (buffer[offset] == HidProtocol.ConfigurationReportId)
                report = ProtocolTests.ConfigurationReport();
            else
            {
                report = new byte[HidProtocol.ControlFeatureSize];
                report[0] = HidProtocol.ControlReportId;
                report[1] = report[2] = 1;
                report[3] = (byte)Opcode.SaveSettings;
                report[4] = (byte)ControlStatus.Completed;
                report[6] = 240;
            }
            report.CopyTo(buffer, offset + prefix);
        }
        public override void SetFeature(byte[] buffer, int offset, int count)
        {
            Writes++;
            if (DetachOnWrite) throw new IOException("detached after SET");
        }
        public override int Read(byte[] buffer, int offset, int count) => 0;
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (!disposing) return;
            Closes++;
            if (CloseError is not null) throw CloseError;
            base.Dispose(disposing);
        }
    }
}
