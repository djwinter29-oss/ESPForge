/**
 * @file zephyrforge.h
 * @brief Zephyr-side services shared by the USB HID, Bluetooth LE, Wi-Fi, storage and telemetry glue.
 */
#ifndef ZEPHYRFORGE_H
#define ZEPHYRFORGE_H

#include <stdbool.h>
#include <stdint.h>

#include "app/usb/hid_reports.h"

#ifndef ZEPHYRFORGE_VERSION
#define ZEPHYRFORGE_VERSION "0.1.0"
#endif

/** Grace period between an accepted reboot or save result and the reset. */
#define ZF_REBOOT_DELAY_MS 1000

/** Report 12 ble_state values. */
#define ZF_BLE_OFF 0u
#define ZF_BLE_ADVERTISING 1u
#define ZF_BLE_CONNECTED 2u

/** One recursive lock serializes the control dispatcher, staging and wireless state across threads. */
void zf_lock(void);
void zf_unlock(void);

/** Board identity; valid after zf_board_init(). */
void zf_board_init(void);
const uint8_t *zf_board_uid(void);
const char *zf_board_serial(void);

void zf_identity_report(uint8_t out[ZF_IDENTITY_SIZE]);
/** Read the immutable boot-sampled module memory inventory. */
void zf_memory_report(uint8_t out[ZF_MEMORY_SIZE]);
void zf_config_report(uint8_t out[ZF_CONFIG_SIZE]);
void zf_telemetry_report(uint8_t sequence, uint8_t out[ZF_TELEMETRY_SIZE]);
void zf_storage_report(uint8_t sequence, uint8_t out[ZF_STORAGE_SIZE]);
void zf_wireless_report(uint8_t out[ZF_WIRELESS_SIZE]);

/**
 * @brief Apply the saved CPU clock profile before transports start.
 * @param mhz Saved clock profile; zero or the devicetree default leaves the clock unchanged.
 * @return Zero on success or no change, otherwise a negative errno.
 */
int zf_system_clock_apply(uint16_t mhz);
/** Running CPU clock in Hz, or the devicetree default when the clock driver cannot report it. */
uint32_t zf_system_clock_hz(void);

void zf_telemetry_init(void);
/** Refresh the cached temperature and load window; call from the main loop. */
void zf_telemetry_poll(void);

void zf_storage_init(void);
/** Read retained benchmark progress without acquiring the media lock. */
void zf_benchmark_report(uint8_t sequence, uint8_t out[ZF_BENCHMARK_SIZE]);
/** Let the storage worker change owners after this Feature 20 result has left the control path. */
void zf_storage_result_read(uint8_t transaction);

void zf_wifi_init(bool enabled);
/** Advance connects, tests and scans; call from the main loop. */
void zf_wifi_poll(void);

/** Start Bluetooth when the saved switch is on and a Control key is saved. */
void zf_ble_init(bool enabled);
uint8_t zf_ble_state(void);
bool zf_ble_failed(void);

int zf_usb_init(void);
bool zf_usb_configured(void);
/** Publish due Input reports; call from the main loop. */
void zf_usb_poll(void);

#endif
