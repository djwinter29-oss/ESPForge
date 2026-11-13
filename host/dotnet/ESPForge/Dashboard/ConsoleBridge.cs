// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace ESPForge;

/// <summary>One bounded plaintext TCP shell relay, tied to a fresh HID connection and expiring after 15 idle seconds.</summary>
internal sealed class ConsoleBridge : IDisposable
{
    private readonly object gate = new();
    private readonly IDashboardBoards boards;
    private readonly TimeProvider time;
    private readonly ITimer expiry;
    private readonly int port;
    private readonly bool allowLoopbackForTests;
    private readonly Func<Socket, ReadOnlyMemory<byte>, CancellationToken, ValueTask<int>> send;
    private Relay? current;
    private string? lastClosed;
    private bool disposed;

    public ConsoleBridge(IDashboardBoards boards) : this(boards, TimeProvider.System, 2323, false) { }

    internal ConsoleBridge(IDashboardBoards boards, TimeProvider time, int port, bool allowLoopbackForTests,
        Func<Socket, ReadOnlyMemory<byte>, CancellationToken, ValueTask<int>>? send = null)
    {
        this.boards = boards;
        this.time = time;
        this.port = port;
        this.allowLoopbackForTests = allowLoopbackForTests;
        this.send = send ?? ((socket, data, cancel) => socket.SendAsync(data, SocketFlags.None, cancel));
        expiry = time.CreateTimer(_ => Expire(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    public async Task<(string Session, string Ipv4)> OpenAsync(string? boardId, CancellationToken cancel)
    {
        if (string.IsNullOrEmpty(boardId)) throw new ApiInputException("Select a board");
        var board = boards.Boards().Boards.SingleOrDefault(board => board.Id == boardId)
            ?? throw new BoardStateException("Board unavailable; rescan and select a connected board");
        var monitor = boards.Monitor(boardId);
        var identity = monitor.ConnectionIdentity ?? throw new BoardStateException("The board is disconnected");
        var address = Address(monitor.Snapshot);
        var relay = new Relay(board, monitor, identity, address, time.GetTimestamp());
        lock (gate)
        {
            if (disposed || current is not null)
            {
                relay.Socket.Dispose();
                throw new BoardStateException("Console busy or shutting down; disconnect it first");
            }
            current = relay;
        }
        var settingEcho = false;
        try
        {
            Validate(relay);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            await relay.Socket.ConnectAsync(new IPEndPoint(address, port), timeout.Token);
            Validate(relay);
            settingEcho = true;
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            // Two Ctrl-C bytes escape a pending ANSI state and discard an abandoned draft before enabling session echo.
            ReadOnlyMemory<byte> setup = "\x03\x03shell echo on\r"u8.ToArray();
            if (await send(relay.Socket, setup, timeout.Token) != setup.Length)
                throw new IOException("Incomplete TCP shell echo setup write");
            Validate(relay);
            lock (gate)
            {
                RequireCurrent(relay);
                relay.Open = true;
                relay.LastRequest = time.GetTimestamp();
            }
            return (relay.Token, address.ToString());
        }
        catch (Exception error)
        {
            var failure = Failure(relay, error);
            if (settingEcho && failure is not BoardStateException)
                throw new IOException("TCP shell echo setup is uncertain; connection closed, do not replay setup", failure);
            throw failure;
        }
    }

    private IPAddress Address(StatusResponse status)
    {
        var wireless = status.Wireless;
        if (!status.Connected || status.Reconnecting || status.RebootPending || status.WirelessCleanupRequired ||
            status.WirelessPhase is not null || status.WirelessError is not null || wireless is null ||
            !wireless.WifiEnabled || wireless.WifiState != WifiState.Connected || !wireless.TcpCliStarted)
            throw new BoardStateException("Waiting for a fresh connected Wi-Fi TCP shell status");
        if (!IPAddress.TryParse(wireless.Ipv4, out var address) ||
            address.AddressFamily != AddressFamily.InterNetwork ||
            (!allowLoopbackForTests && IPAddress.IsLoopback(address)) ||
            address.GetAddressBytes()[0] == 0 || address.Equals(IPAddress.Broadcast) ||
            address.GetAddressBytes()[0] >= 224)
            throw new BoardStateException("The board reported an invalid Wi-Fi IPv4 address");
        return address;
    }

    // Discovery and snapshot locks end before any socket I/O or session-gate acquisition.
    private void Validate(Relay relay)
    {
        try
        {
            var board = boards.Boards().Boards.SingleOrDefault(board => board.Id == relay.Board.Id);
            if (board != relay.Board || !ReferenceEquals(boards.Monitor(relay.Board.Id), relay.Monitor) ||
                !ReferenceEquals(relay.Monitor.ConnectionIdentity, relay.Identity) ||
                !Address(relay.Monitor.Snapshot).Equals(relay.Address) ||
                !ReferenceEquals(relay.Monitor.ConnectionIdentity, relay.Identity))
                throw new BoardStateException("Console board connection or Wi-Fi address changed; connect again");
        }
        catch (Exception error)
        {
            lock (gate) Close(relay);
            if (error is BoardStateException or KeyNotFoundException or ObjectDisposedException)
                throw new BoardStateException("Console board unavailable or stale; connect again");
            throw;
        }
    }

    private Relay Session(string? token)
    {
        Relay relay;
        lock (gate)
        {
            ExpireLocked();
            relay = current ?? throw new BoardStateException("Console disconnected; connect again");
            if (!relay.Open || !Matches(token, relay.Token))
                throw new BoardStateException("Wrong or stale console session");
            relay.LastRequest = time.GetTimestamp();
        }
        Validate(relay);
        lock (gate) RequireCurrent(relay);
        return relay;
    }

    private static bool Matches(string? token, string expected) => token is not null &&
        token.Length == expected.Length && CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(expected));

    public async Task<(byte[] Data, bool Closed)> ReadAsync(string? token, CancellationToken cancel)
    {
        var relay = Session(token);
        lock (gate)
        {
            RequireCurrent(relay);
            if (relay.Reading) throw new BoardStateException("Console read already pending");
            relay.Reading = true;
        }
        try
        {
            var data = new byte[4096];
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            int count;
            try { count = await relay.Socket.ReceiveAsync(data, SocketFlags.None, timeout.Token); }
            catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { count = -1; }
            Validate(relay);
            lock (gate)
            {
                RequireCurrent(relay);
                if (count == 0) Close(relay);
            }
            return (count > 0 ? data[..count] : [], count == 0);
        }
        catch (Exception error) { throw Failure(relay, error); }
        finally { lock (gate) relay.Reading = false; }
    }

    public async Task<int> WriteAsync(string? token, byte[] data, CancellationToken cancel)
    {
        var relay = Session(token);
        lock (gate)
        {
            RequireCurrent(relay);
            if (relay.Writing) throw new BoardStateException("Console write already pending");
            relay.Writing = true;
        }
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            // A partial send is reported and closed, never completed by replaying the remaining bytes.
            var written = await send(relay.Socket, data, timeout.Token);
            Validate(relay);
            lock (gate)
            {
                RequireCurrent(relay);
                if (written != data.Length) Close(relay);
            }
            return written;
        }
        catch (Exception error) { throw Failure(relay, error); }
        finally { lock (gate) relay.Writing = false; }
    }

    public void Close(string? token)
    {
        lock (gate)
        {
            ExpireLocked();
            if (current is null && lastClosed is not null && Matches(token, lastClosed)) return;
        }
        var relay = Session(token);
        lock (gate) Close(relay);
    }

    private Exception Failure(Relay relay, Exception error)
    {
        lock (gate)
        {
            var detached = !ReferenceEquals(current, relay);
            Close(relay);
            if (detached || error is BoardStateException)
                return new BoardStateException("Console disconnected or stale; connect again");
        }
        return error is OperationCanceledException ? error : new IOException(
            "TCP shell connection failed; input may have been partially written, do not replay it", error);
    }

    private void RequireCurrent(Relay relay)
    {
        if (disposed || !ReferenceEquals(current, relay))
            throw new BoardStateException("Console disconnected; connect again");
    }

    private void Close(Relay relay)
    {
        relay.Socket.Dispose();
        if (!ReferenceEquals(current, relay)) return;
        lastClosed = relay.Token;
        current = null;
    }

    internal void Expire() { lock (gate) ExpireLocked(); }

    private void ExpireLocked()
    {
        if (current is { } relay && time.GetElapsedTime(relay.LastRequest) >= TimeSpan.FromSeconds(15))
            Close(relay);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (current is { } relay) Close(relay);
            expiry.Dispose();
        }
    }

    /// <summary>Captured ownership and independent read/write admission; mutable members are guarded by the gate.</summary>
    private sealed class Relay(DashboardBoard board, IDeviceMonitor monitor, object identity,
        IPAddress address, long lastRequest)
    {
        public readonly DashboardBoard Board = board;
        public readonly IDeviceMonitor Monitor = monitor;
        public readonly object Identity = identity;
        public readonly IPAddress Address = address;
        public readonly Socket Socket = new(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        public readonly string Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        public long LastRequest = lastRequest;
        public bool Open;
        public bool Reading;
        public bool Writing;
    }
}
