/**
 * @file ef_platform.h
 * @brief Board services the portable control dispatcher calls; implemented in Zephyr glue, mocked in tests.
 */
#ifndef ESPFORGE_EF_PLATFORM_H
#define ESPFORGE_EF_PLATFORM_H

#include <stdbool.h>
#include <stdint.h>

/** Feature 12 scan_state values. */
#define EF_SCAN_IDLE 0u
#define EF_SCAN_RUNNING 1u
#define EF_SCAN_COMPLETE 2u
#define EF_SCAN_FAILED 3u

/** Queue a reset after the result-read grace period. */
int ef_platform_schedule_reboot(void);
/** Initialize the onboard addressable LED to Off before management starts. */
void ef_platform_led_init(void);
/** Queue an RGB bitmask (red=1, green=2, blue=4); returns zero or negative errno without SPI I/O. */
int ef_platform_led_request(uint8_t colour);
/** Copy the last successfully transmitted colour and driver availability. */
void ef_platform_led_status(uint8_t *colour, bool *available);
/** True while the storage worker is busy or USB exclusively owns the card. */
bool ef_platform_storage_busy(void);
/** Admit one USB ownership request without doing disk I/O; correlate its result before USB refresh. */
int ef_platform_storage_request(bool usb, uint8_t transaction);
/** Admit or cancel a serialized benchmark; returns a benchmark detail code without disk I/O. */
int ef_platform_benchmark_request(bool start, uint32_t size_mib);

/** True while a candidate test is joining (Feature 12 wifi_state 4). */
bool ef_wifi_test_active(void);
bool ef_wifi_scan_active(void);

/** Start joining a candidate pair; password is NUL-terminated (empty for an open network). */
int ef_wifi_test_start(const uint8_t *ssid, uint8_t ssid_length, const char *password);

/** Drop any candidate test link and return to the saved network when Wi-Fi is enabled. */
void ef_wifi_test_cancel(void);

int ef_wifi_scan_start(void);
uint8_t ef_wifi_scan_state(void);
uint16_t ef_wifi_scan_generation(void);
uint8_t ef_wifi_scan_count(void);

/** Copy one completed scan entry; ssid must hold 32 bytes. */
int ef_wifi_scan_entry(uint8_t index, uint8_t *ssid, uint8_t *ssid_length, int8_t *rssi, uint8_t *security);

#endif
