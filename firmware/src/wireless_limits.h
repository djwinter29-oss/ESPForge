/**
 * @file wireless_limits.h
 * @brief Shared Wi-Fi credential size limits.
 */
#ifndef ZEPHYRFORGE_WIRELESS_LIMITS_H
#define ZEPHYRFORGE_WIRELESS_LIMITS_H

/** Maximum Wi-Fi SSID length in bytes, excluding a string terminator. */
#define ZF_SSID_MAX_BYTES 32u
/** Buffer size for a NUL-terminated Wi-Fi SSID. */
#define ZF_SSID_BUFFER_SIZE (ZF_SSID_MAX_BYTES + 1u)

#endif
