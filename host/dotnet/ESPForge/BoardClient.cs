using System.Diagnostics;
using System.IO.Ports;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ESPForge;

public sealed class ProtocolException(string message) : Exception(message);

public static class Protocol
{
    public static void ValidateRequest(JsonObject request)
    {
        string? op;
        try { op = request["op"]?.GetValue<string>(); }
        catch (InvalidOperationException) { throw new ProtocolException("Operation must be a string"); }
        if (op == "status" && request.Count == 1) return;
        if (op != "wifi.connect" || request.Count != 3 ||
            !request.ContainsKey("ssid") || !request.ContainsKey("psk"))
            throw new ProtocolException("Unsupported operation or unexpected fields");
        string ssid, psk;
        try
        {
            ssid = request["ssid"]?.GetValue<string>() ?? throw new ProtocolException("SSID required");
            psk = request["psk"]?.GetValue<string>() ?? throw new ProtocolException("Passphrase required");
        }
        catch (InvalidOperationException) { throw new ProtocolException("Credentials must be strings"); }
        if (ssid.Contains('\0') || psk.Contains('\0'))
            throw new ProtocolException("Credentials cannot contain NUL");
        if (Encoding.UTF8.GetByteCount(ssid) is < 1 or > 32)
            throw new ProtocolException("SSID must be 1-32 UTF-8 bytes");
        if (psk.Length != 0 && Encoding.UTF8.GetByteCount(psk) is < 8 or > 63)
            throw new ProtocolException("Passphrase must be empty or 8-63 UTF-8 bytes");
    }

    public static JsonObject DemoStatus() => new()
    {
        ["protocol"] = 1, ["product"] = "ESPForge", ["board"] = "ESP32-S3-DevKitC",
        ["firmware"] = "0.1.0 (simulated)", ["uptime_ms"] = 123000,
        ["wifi_enabled"] = true, ["ble_enabled"] = true, ["wifi_connected"] = false,
        ["wifi_error"] = 0, ["ble_error"] = 0, ["sd_mounted"] = false, ["sd_error"] = -19
    };
}

public sealed class BoardClient : IDisposable
{
    private readonly SerialPort serial;
    private readonly object gate = new();
    private int id;

    public BoardClient(string device)
    {
        serial = new SerialPort(device, 115200)
        {
            ReadTimeout = 250, WriteTimeout = 2000, DtrEnable = false, RtsEnable = false
        };
        try { serial.Open(); }
        catch { serial.Dispose(); throw; }
    }

    public JsonObject Request(JsonObject request)
    {
        Protocol.ValidateRequest(request);
        lock (gate)
        {
            id = id == int.MaxValue ? 1 : id + 1;
            var frame = (JsonObject)request.DeepClone();
            if (frame["op"]!.GetValue<string>() == "wifi.connect")
            {
                frame = new JsonObject
                {
                    ["op"] = "wifi.connect",
                    ["ssid_hex"] = Convert.ToHexString(Encoding.UTF8.GetBytes(request["ssid"]!.GetValue<string>())),
                    ["psk_hex"] = Convert.ToHexString(Encoding.UTF8.GetBytes(request["psk"]!.GetValue<string>()))
                };
            }
            frame["id"] = id;
            var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString() + "\n");
            if (bytes.Length > 512) throw new ProtocolException("Request exceeds 512 bytes");
            serial.Write(bytes, 0, bytes.Length);
            var watch = Stopwatch.StartNew();
            var line = new List<byte>();
            while (watch.Elapsed < TimeSpan.FromSeconds(5))
            {
                int value;
                try { value = serial.ReadByte(); }
                catch (TimeoutException) { continue; }
                if (value != '\n')
                {
                    line.Add((byte)value);
                    if (line.Count > 4096) throw new ProtocolException("Serial receive frame too large");
                    continue;
                }
                string text = Encoding.UTF8.GetString(line.ToArray()).Trim();
                line.Clear();
                if (!text.StartsWith('{')) continue;
                JsonObject reply;
                try { reply = JsonNode.Parse(text) as JsonObject ?? throw new ProtocolException("Malformed board response"); }
                catch (JsonException) { throw new ProtocolException("Malformed board JSON"); }
                try
                {
                    var replyId = reply["id"]?.GetValue<int>();
                    if (replyId == 0 && reply["ok"]?.GetValue<bool>() == false)
                        throw new ProtocolException($"Device rejected frame ({reply["error"]})");
                    if (replyId != id) continue;
                    if (reply["ok"]?.GetValue<bool>() != true)
                        throw new ProtocolException($"Device error {reply["error"]}");
                    if (request["op"]!.GetValue<string>() == "status" && reply["status"] is not JsonObject)
                        throw new ProtocolException("Board status missing");
                }
                catch (InvalidOperationException) { throw new ProtocolException("Malformed board fields"); }
                return reply;
            }
            throw new ProtocolException("Board timeout; command was not retried");
        }
    }

    public void Dispose() => serial.Dispose();
}
