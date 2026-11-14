/**
 * @file espforge.h
 * @brief Zephyr-side services shared by the USB HID, Bluetooth LE, Wi-Fi, storage and telemetry glue.
 */
#ifndef ESPFORGE_H
#define ESPFORGE_H

#include <stdbool.h>
#include <stdint.h>

#include "app/usb/hid_reports.h"

#ifndef ESPFORGE_VERSION
#define ESPFORGE_VERSION "0.1.0"
#endif

/** Grace period between an accepted reboot or save result and the reset. */
#define EF_REBOOT_DELAY_MS 1000

/** Report 12 ble_state values. */
#define EF_BLE_OFF 0u
#define EF_BLE_ADVERTISING 1u
#define EF_BLE_CONNECTED 2u

/** One recursive lock serializes the control dispatcher, staging and wireless state across threads. */
void ef_lock(void);
void ef_unlock(void);

/** Board identity; valid after ef_board_init(). */
void ef_board_init(void);
const uint8_t *ef_board_uid(void);
const char *ef_board_serial(void);

void ef_identity_report(uint8_t out[EF_IDENTITY_SIZE]);
/** Read the immutable boot-sampled module memory inventory. */
void ef_memory_report(uint8_t out[EF_MEMORY_SIZE]);
void ef_config_report(uint8_t out[EF_CONFIG_SIZE]);
void ef_telemetry_report(uint8_t sequence, uint8_t out[EF_TELEMETRY_SIZE]);
void ef_storage_report(uint8_t sequence, uint8_t out[EF_STORAGE_SIZE]);
void ef_wireless_report(uint8_t out[EF_WIRELESS_SIZE]);

int system_clock_apply(uint16_t mhz);
uint32_t system_clock_hz(void);

void ef_telemetry_init(void);
/** Refresh the cached temperature and load window; call from the main loop. */
void ef_telemetry_poll(void);

void ef_storage_init(void);
/** Read retained benchmark progress without acquiring the media lock. */
void ef_benchmark_report(uint8_t sequence, uint8_t out[EF_BENCHMARK_SIZE]);
/** Let the storage worker change owners after this Feature 20 result has left the control path. */
void ef_storage_result_read(uint8_t transaction);
/** Refresh native USB after confirmed handoff; called only by the storage worker. */
int ef_storage_usb_refresh(void);

void ef_wifi_init(bool enabled);
/** Advance connects, tests and scans; call from the main loop. */
void ef_wifi_poll(void);

/** Start Bluetooth when the saved switch is on and a Control key is saved. */
void ef_ble_init(bool enabled);
uint8_t ef_ble_state(void);
bool ef_ble_failed(void);

int ef_usb_init(void);
bool ef_usb_configured(void);
/** Publish due Input reports; call from the main loop. */
void ef_usb_poll(void);

#endif
