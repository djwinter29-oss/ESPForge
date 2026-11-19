/**
 * @file wireless_limits.h
 * @brief Shared Wi-Fi credential size limits.
 */
#ifndef ESPFORGE_WIRELESS_LIMITS_H
#define ESPFORGE_WIRELESS_LIMITS_H

/** Maximum Wi-Fi SSID length in bytes, excluding a string terminator. */
#define EF_SSID_MAX_BYTES 32u
/** Buffer size for a NUL-terminated Wi-Fi SSID. */
#define EF_SSID_BUFFER_SIZE (EF_SSID_MAX_BYTES + 1u)

#endif
