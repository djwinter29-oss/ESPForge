# Wireless Setup and Operation

Wi-Fi and Bluetooth LE are compiled in, and both radio switches **default to enabled**. Wi-Fi joins its saved network
at boot, while a dashboard can temporarily test a candidate network. BLE advertises only when it is enabled and a
Control key is saved. Radio switches and saved credentials are boot settings; see the
[settings design](../reference/settings.md) for persistence and save behaviour. Espressif software coexistence is
enabled.

## Configuration and operation

Use USB to provision wireless settings. In Python and .NET, open the selected board's **Boot configuration**. In the
Direct dashboard, open **Board configuration**. Use **Configure…** to scan and test Wi-Fi or to create a Control key.
The radio switches are separate next-boot controls.

### Wi-Fi

Select a scanned network or enter a hidden SSID, enter its password if needed, and test the connection. Only a
successful test stages the credentials, and **Save&Reboot** is the only action that writes them to flash. Staged
credentials expire after ten minutes. Canceling discards them and returns to the saved network. If a test succeeds,
save before it expires or test again.

Use a 2.4 GHz WPA2-Personal or open network with DHCP; WPA3-SAE and enterprise networks are not supported. A test
succeeds when the board has an IPv4 address. A join that does not finish within 30 seconds fails. While a saved
network is lost, the board retries every 5 seconds, doubling the delay up to 60 seconds. The Zephyr ESP32 driver does
not report why a join failed, so a wrong password and a missing network look the same; see the
[ESPForge failure details](../reference/espforge-implementation.md#report-12-wireless).

### Bluetooth LE

Create a Control key and copy it to a password manager before saving: the board never returns the key. Bluetooth
stays off until a key is saved. To connect, choose the Direct dashboard's **Bluetooth** option, enter the key, and
select `ESPForge-<serial>`. Use desktop Chrome or Edge with Web Bluetooth, served from localhost or HTTPS. Python and
.NET can provision Bluetooth settings over USB but do not connect over BLE.

The Control key authenticates commands. It is not a Bluetooth pairing password and does not encrypt the link. See the
[Bluetooth LE protocol](../reference/bluetooth.md) and the [ESPForge differences](../reference/espforge-implementation.md#bluetooth-le-differences).

### Save and dashboard differences

**Save&Reboot** commits the radio switches and staged credentials with the other boot settings, then reboots after a
verified save. ESPForge has no USB mass storage, so there is no forced save.

Python and .NET manage the selected USB-attached board. Direct supports USB (WebHID) and BLE, with a restricted set of
actions over BLE. See the [Direct dashboard guide](../../host/direct/README.md).

Live diagnostics report the wireless state; an enabled switch does not mean the radio is connected. ESPForge has no
TCP CLI.

## Security boundaries

- The Control key authenticates BLE commands but does not encrypt BLE traffic. BLE reads of telemetry, storage and
  wireless state require an unlocked session.
- Saved Wi-Fi credentials and the Control key are **unencrypted in flash**. Anyone with physical flash, UART-download
  or JTAG access can read them. They are never returned in reports, kept in browser storage or written to the SD card.
- Python and .NET bind to loopback and reject foreign Host/Origin headers. Do not expose or reverse-proxy them onto a
  LAN without a separate authentication design.

## Qualification

Host checks and target builds do not qualify physical radio behaviour. No coexistence, RF performance, power
consumption or range has been measured. Review the [qualification gaps](../validation/qualification-gaps.md) before
relying on a hardware configuration.
