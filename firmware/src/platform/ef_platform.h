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
