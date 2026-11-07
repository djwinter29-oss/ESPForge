using ESPForge;
using System.Text.Json.Nodes;

static JsonObject Parse(string json) => JsonNode.Parse(json) as JsonObject ?? throw new Exception("Test object required");
static void Require(bool value, string message)
{
    if (!value) throw new Exception(message);
}

foreach (var valid in new[]
{
    """{"op":"status"}""",
    """{"op":"wifi.connect","ssid":"lab","psk":""}""",
    $$"""{"op":"wifi.connect","ssid":"{{new string('a', 32)}}","psk":"{{new string('a', 63)}}"}"""
})
    Protocol.ValidateRequest(Parse(valid));

foreach (var invalid in new[]
{
    """{"op":"other"}""", """{"op":"status","id":1}""", """{"op":42}""",
    """{"op":"wifi.connect","ssid":"lab"}""",
    """{"op":"wifi.connect","ssid":"lab","psk":42}""",
    """{"op":"wifi.connect","ssid":"lab\u0000","psk":""}""",
    """{"op":"wifi.connect","ssid":"lab","psk":"short"}""",
    $$"""{"op":"wifi.connect","ssid":"{{new string('a', 33)}}","psk":""}""",
    $$"""{"op":"wifi.connect","ssid":"{{new string('\u00e9', 17)}}","psk":""}"""
})
{
    bool rejected = false;
    try { Protocol.ValidateRequest(Parse(invalid)); }
    catch (ProtocolException) { rejected = true; }
    Require(rejected, $"Invalid request accepted: {invalid}");
}
var status = Protocol.DemoStatus();
Require(status["protocol"]!.GetValue<int>() == 1, "Wrong protocol");
Require(status["sd_mounted"]!.GetValue<bool>() == false, "Demo must not imply storage qualification");
Require(status["firmware"]!.GetValue<string>().Contains("simulated"), "Demo label missing");

if (args.Length == 2 && args[0] == "--device")
{
    using var client = new BoardClient(args[1]);
    Require(client.Request(Parse("""{"op":"status"}"""))["status"] is JsonObject, "Missing UART status");
    Require(client.Request(Parse("""{"op":"wifi.connect","ssid":"lab\"\u00e9","psk":"pass\\word"}"""))["ok"]!.GetValue<bool>(),
        "Synthetic provisioning response failed");
}
Console.WriteLine("PASS: .NET protocol validation, demo contract" + (args.Length > 0 ? " and synthetic serial" : ""));
