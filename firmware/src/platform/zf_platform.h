/**
 * @file zf_platform.h
 * @brief Board services the portable control dispatcher calls; implemented in Zephyr glue, mocked in tests.
 */
#ifndef ZEPHYRFORGE_ZF_PLATFORM_H
#define ZEPHYRFORGE_ZF_PLATFORM_H

#include <stdbool.h>
#include <stdint.h>

#include "wireless_limits.h"

/** Feature 12 scan_state values. */
#define ZF_SCAN_IDLE 0u
#define ZF_SCAN_RUNNING 1u
#define ZF_SCAN_COMPLETE 2u
#define ZF_SCAN_FAILED 3u

/** Queue a reset after the result-read grace period. */
int zf_platform_schedule_reboot(void);
/** Initialize the onboard addressable LED to Off before management starts. */
void zf_platform_led_init(void);
/** Queue an RGB bitmask (red=1, green=2, blue=4); returns zero or negative errno without SPI I/O. */
int zf_platform_led_request(uint8_t colour);
/** Copy the last successfully transmitted colour and driver availability. */
void zf_platform_led_status(uint8_t *colour, bool *available);
/** True while the storage worker is busy or USB exclusively owns the card. */
bool zf_platform_storage_busy(void);
/**
 * @brief Admit one USB ownership request without doing disk I/O; correlate its result before USB refresh.
 * @param usb True requests USB ownership; false returns the medium to firmware.
 * @param transaction Feature 20 transaction whose result read shortens the handoff delay.
 * @return Zero when admitted or the owner is already active, -EBUSY while storage is busy, -ENOMEDIUM when
 *         USB is requested without an initialized card with valid geometry, or another negative errno.
 */
int zf_platform_storage_request(bool usb, uint8_t transaction);
/**
 * @brief Admit or cancel a serialized benchmark without disk I/O.
 * @param start True starts a run; false cancels any active run.
 * @param size_mib Run size in MiB when starting; zero when cancelling.
 * @return ZF_BENCHMARK_ERROR_NONE when admitted, an zf_benchmark_error_t admission detail, or -ENOTSUP
 *         when the benchmark is not built in.
 */
int zf_platform_benchmark_request(bool start, uint32_t size_mib);

/** True while a candidate test is joining (Feature 12 wifi_state 4). */
bool zf_wifi_test_active(void);
bool zf_wifi_scan_active(void);

/** Start joining a candidate pair; password is NUL-terminated (empty for an open network). */
int zf_wifi_test_start(const uint8_t *ssid, uint8_t ssid_length, const char *password);

/** Drop any candidate test link and return to the saved network when Wi-Fi is enabled. */
void zf_wifi_test_cancel(void);

int zf_wifi_scan_start(void);
uint8_t zf_wifi_scan_state(void);
uint16_t zf_wifi_scan_generation(void);
uint8_t zf_wifi_scan_count(void);

/** Copy one completed scan entry; ssid must hold ZF_SSID_MAX_BYTES bytes. */
int zf_wifi_scan_entry(uint8_t index, uint8_t *ssid, uint8_t *ssid_length, int8_t *rssi, uint8_t *security);

#endif
