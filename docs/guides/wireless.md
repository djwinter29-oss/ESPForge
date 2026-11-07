# Wi-Fi and Bluetooth LE

Wi-Fi and BLE are compiled in and initialized on every boot. There are no persisted switches
that can silently turn them off. Espressif software coexistence is enabled.
`wifi_enabled` and `ble_enabled` describe intended defaults, **not** successful initialization;
inspect their separate result codes.

## Wi-Fi

The firmware brings up the Wi-Fi interface and starts DHCPv4. It does not join an arbitrary network
without credentials and does not start an access point.

1. Connect a dashboard over USB-UART (Direct, Python, or .NET).
2. Enter a 2.4 GHz SSID and WPA2-Personal passphrase, or leave the passphrase empty for an open network.
3. Select **Connect Wi-Fi for this boot**.
4. A successful command only acknowledges request submission. Wait for `wifi_connected=true`
   and `wifi_error=0`. Association does not assert DHCP lease acquisition or internet access.

Credentials remain in RAM and must be supplied again after reboot. They are never returned in status,
stored in browser storage, written to the SD card, or saved in flash.
This avoids inventing an unprotected persistent credential store in the initial setup.
One connection attempt may be active; connecting while already associated or connecting returns
an error. To change networks, reset the board and provision again.
No scan UI, WPA3, enterprise authentication, reconnection policy, or Wi-Fi management server is provided.

## BLE

The board advertises the ESPForge service and exposes read-only diagnostics to Direct over Web Bluetooth.
BLE provides no provisioning or write/control characteristic. Advertising is restarted when a
connection object is recycled after disconnect. One connection is supported.
UUIDs and long-read semantics belong to the [protocol reference](../reference/protocol.md#ble).

## Security boundaries

BLE diagnostics are public, unpaired and unencrypted; nearby devices can read uptime and status.
Do not add sensitive values to that characteristic without introducing authorization and link security.
UART provisioning assumes physical access and is plaintext (hex encoding is not encryption).
Python/.NET bridges bind to loopback, reject foreign Host/Origin headers, and require JSON POSTs.
Do not expose or reverse-proxy them onto a LAN without a separate authentication design.
Wi-Fi connection encrypts radio traffic only according to the selected network security.
No wireless coexistence, RF performance, power consumption or range has been hardware-qualified.
