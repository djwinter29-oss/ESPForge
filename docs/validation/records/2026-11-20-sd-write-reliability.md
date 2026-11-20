# Native SDMMC write reliability

Executed on **2026-11-20** with the user's ESP32-S3-DevKitC-1 N16R8, a hand-wired native four-bit SDMMC breakout and
a user-identified SanDisk Extreme 64 GB SDXC card. The card's CID fields were not retained in the logs.
The host was a Raspberry Pi running Linux with the Python bridge on loopback; UART logs used the CH343 port at
115200 baud. Firmware was based on commit `6fedb5a` with Zephyr 4.3.2 (`28af05ca`) and SDK 0.17.4.
Test images enabled the storage benchmark and a UART filesystem shell. Some also contained temporary SDHC driver
logging, a pad-register shell and FatFs mkfs. None of these diagnostics are in tracked source.

## Symptom

Card initialization, CID, exFAT mount, reads and USB drive export worked. Large firmware writes failed: a 64 MiB
benchmark started immediately after reset failed in 5 of 5 runs. Each failure was a multi-block write (CMD25) answered
with a negative data-CRC status token. The failing offset followed the written data pattern rather than the card
address, and a lower bus clock did not remove it.

## Cause and change

Zephyr's Espressif pinctrl did not configure pad drive, so SD pads kept the ESP32-S3 reset default of about 20 mA.
Tracked Zephyr patch `0002-pinctrl-esp32-drive-strength.patch` adds an optional `drive-strength` pin-group property.
The native SDMMC overlay sets 10 mA on CLK, CMD and DAT0-DAT3. Register readback in a diagnostic image confirmed the
10 mA setting on GPIO10-GPIO15.

| Run (benchmark through the bridge) | Pad drive | Result |
| --- | --- | --- |
| 64 MiB after each reset, before the change | Reset default, about 20 mA | 0/5 pass, write CRC error |
| 64 MiB after each reset, runtime override | About 20 mA | 0/3 pass, same offset |
| 64 MiB after each reset, runtime override | About 10 mA | 3/3 pass |
| 64 MiB after each reset, devicetree setting | 10 mA | 5/5 pass, about 7.0 MB/s write and 8.2 MB/s read |
| 256, 128 and 16 MiB chained after one reset | 10 mA | Pass |
| 1024 MiB chained after the runs above | 10 mA | Inconclusive, USB lockup below |

## Discarded recovery experiment

A diagnostic driver change sent CMD12 after a failed write. The card recovered, but later transfers produced no
controller interrupts for 10 seconds and the exFAT volume became unmountable. The change was discarded; the stock
driver leaves the card failed until reinitialization and did not corrupt data in these runs. The card, holding
only test data, was reformatted as exFAT from a diagnostic image.

## USB lockup during long benchmarks

During the 1024 MiB run, Linux reset the native USB device about every 33 seconds and later could not enumerate it.
The CH343 bridge on the same hub then stopped answering control requests and had not recovered when this was written.
MSC disk callbacks waited without limit for media owned by the benchmark, so host SCSI commands timed out and
triggered resets. Firmware now reports no medium immediately while it owns the card and bounds the remaining
ownership-transition wait to 1 second. The changed production image built without warnings; hardware results for it
are not yet recorded.

## Interference

During one session another user or tool reset the board into download mode and flashed a different image. That
run was discarded and the diagnostic image reflashed. A Windows `System Volume Information` folder later appeared
on the card.

## Not tested

Other cards and breakouts, wiring changes, the SPI image, temperature variation, removal during writes, power loss,
soak or endurance, and other Espressif SoCs with the pinctrl patch (only ESP32-S3 was compiled). This record is
evidence for one card and wiring combination, not qualification.
