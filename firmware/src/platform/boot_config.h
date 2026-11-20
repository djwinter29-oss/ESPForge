/**
 * @file boot_config.h
 * @brief ZephyrForge boot settings for the ESP32-S3 Zephyr application.
 *
 * One CRC-protected record in the `storage_partition` holds the
 * system clock profile, radio switches and credentials. Setters stage values in RAM; zf_boot_config_save() commits
 * them as one unit. Saved values apply at the next boot only.
 *
 * This API is not thread-safe. Call zf_boot_config_load() once before other threads use settings; afterwards all
 * access must be serialized with the application lock (zf_lock()/zf_unlock()). Management callbacks can stage
 * and save settings; ownership is not limited to the main thread.
 */

#ifndef ZEPHYRFORGE_BOOT_CONFIG_H
#define ZEPHYRFORGE_BOOT_CONFIG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "wireless_limits.h"

/** Wi-Fi radio master-switch bit. */
#define ZF_WIRELESS_WIFI 1u
/** BLE radio master-switch bit. */
#define ZF_WIRELESS_BLE 2u
/** NUL-terminated passphrase storage size, including its terminator. */
#define ZF_WIFI_PASSWORD_SIZE 64u
/** Control key size in bytes. */
#define ZF_BLE_KEY_SIZE 32u
/** Serialized record size in bytes. */
#define ZF_BOOT_CONFIG_RECORD_SIZE 148u

/** Stored authentication states; the current ESP32-S3 Wi-Fi implementation uses open networks or WPA2-PSK. */
typedef enum {
	ZF_WIFI_AUTH_TRY_WPA2 = 0, /**< Mode unknown; try WPA2 first. */
	ZF_WIFI_AUTH_TRY_SAE = 1,  /**< Mode unknown; try WPA3-SAE. */
	ZF_WIFI_AUTH_WPA2 = 2,     /**< WPA2 connection was confirmed. */
	ZF_WIFI_AUTH_SAE = 3,      /**< WPA3-SAE connection was confirmed. */
} zf_wifi_auth_state_t;

/** User-selected CPU clock profile; flash stores its ID, while host protocols carry MHz. */
typedef enum {
	ZF_SYSCLK_DEFAULT = 0, /**< Keep the devicetree/build clock (240 MHz); used when nothing is saved. */
	ZF_SYSCLK_80MHZ = 1,   /**< 80 MHz. */
	ZF_SYSCLK_160MHZ = 2,  /**< 160 MHz. */
	ZF_SYSCLK_240MHZ = 3,  /**< 240 MHz. */
} zf_sysclk_profile_t;

/** Where the RAM copy came from at the last load. */
typedef enum {
	ZF_BOOT_CONFIG_NOT_LOADED = 0, /**< zf_boot_config_load() has not run; defaults are in use. */
	ZF_BOOT_CONFIG_DEFAULTS = 1,   /**< The record is erased or invalid; defaults are in use. */
	ZF_BOOT_CONFIG_SAVED = 2,      /**< A valid saved record was loaded. */
	ZF_BOOT_CONFIG_READ_ERROR = 3, /**< Flash could not be read; defaults are in use. */
} zf_boot_config_source_t;

/**
 * @brief Convert a CPU clock profile to MHz.
 * @return 0 (keep the build clock) for ZF_SYSCLK_DEFAULT or an unknown profile, otherwise 80, 160 or 240.
 */
static inline uint16_t zf_sysclk_profile_mhz(zf_sysclk_profile_t profile)
{
	static const uint16_t mhz[] = {0u, 80u, 160u, 240u};

	return (unsigned)profile < sizeof(mhz) / sizeof(mhz[0]) ? mhz[profile] : 0u;
}

/**
 * @brief Convert a protocol MHz value to a CPU clock profile.
 * @return The matching profile, or an out-of-range profile rejected by zf_boot_config_set_sysclk().
 */
static inline zf_sysclk_profile_t zf_sysclk_profile_from_mhz(uint16_t mhz)
{
	unsigned profile = ZF_SYSCLK_DEFAULT;

	while (profile <= ZF_SYSCLK_240MHZ && zf_sysclk_profile_mhz((zf_sysclk_profile_t)profile) != mhz) {
		++profile;
	}
	return (zf_sysclk_profile_t)profile;
}

/**
 * @brief Read and validate the saved record, replacing the RAM copy and the boot snapshot.
 *
 * An erased, invalid or unreadable record loads complete defaults: every radio allowed, the build clock, and no
 * credentials. Boot never depends on flash succeeding.
 */
void zf_boot_config_load(void);
/** @brief Report where the current RAM copy came from. */
zf_boot_config_source_t zf_boot_config_source(void);

/** @brief Return the staged CPU clock profile. */
zf_sysclk_profile_t zf_boot_config_sysclk(void);
/**
 * @brief Stage a CPU clock profile; persist with zf_boot_config_save(), applied at the next boot.
 * @return false (configuration unchanged) for an unknown profile.
 */
bool zf_boot_config_set_sysclk(zf_sysclk_profile_t profile);
/** @brief Return the CPU clock profile loaded at boot, which is the one the running firmware applied. */
zf_sysclk_profile_t zf_boot_config_boot_sysclk(void);

/** @brief Return the staged ZF_WIRELESS_* radios allowed to start at boot; both by default. */
uint8_t zf_boot_config_radios(void);
/**
 * @brief Stage the ZF_WIRELESS_* radio switches; persist with zf_boot_config_save(), applied at the next boot.
 * @return false (configuration unchanged) for unknown bits.
 */
bool zf_boot_config_set_radios(uint8_t radios);
/** @brief Return the radios loaded at boot, which are the ones the running firmware started. */
uint8_t zf_boot_config_boot_radios(void);

/**
 * @brief Copy the staged SSID into a NUL-terminated buffer.
 *
 * Opaque SSIDs may contain embedded zeros; use the byte getter for network identity.
 */
void zf_boot_config_wifi_ssid(char ssid[ZF_SSID_BUFFER_SIZE]);
/**
 * @brief Stage an SSID string; an empty string clears it.
 * @return false for null or a string longer than ZF_SSID_MAX_BYTES.
 */
bool zf_boot_config_set_wifi_ssid(const char *ssid);
/**
 * @brief Copy the staged opaque SSID, zero padded to ZF_SSID_MAX_BYTES.
 * @return Saved byte length, including embedded zero bytes.
 */
uint8_t zf_boot_config_wifi_ssid_bytes(uint8_t ssid[ZF_SSID_MAX_BYTES]);
/**
 * @brief Stage an opaque SSID without text conversion.
 * @param ssid Bytes to copy; may be null only when length is zero.
 * @param length Byte length, zero through ZF_SSID_MAX_BYTES.
 */
bool zf_boot_config_set_wifi_ssid_bytes(const uint8_t *ssid, uint8_t length);
/** @brief Copy the staged private passphrase; never expose it in a host report. */
void zf_boot_config_wifi_password(char password[ZF_WIFI_PASSWORD_SIZE]);
/**
 * @brief Stage a passphrase; empty clears it, otherwise it must be 8-63 non-NUL bytes (UTF-8 is accepted).
 * @return false for null or an invalid passphrase.
 */
bool zf_boot_config_set_wifi_password(const char *password);
/** @brief Return whether a Wi-Fi passphrase is staged, without copying it. */
bool zf_boot_config_wifi_password_configured(void);
/** @brief Return the staged Wi-Fi authentication state; erased or invalid settings try WPA2. */
zf_wifi_auth_state_t zf_boot_config_wifi_auth_state(void);
/** @brief Stage the Wi-Fi authentication state; false for an unknown state. */
bool zf_boot_config_set_wifi_auth_state(zf_wifi_auth_state_t state);

/** @brief Copy the staged private BLE Control key; never expose it in a host report. */
void zf_boot_config_ble_key(uint8_t key[ZF_BLE_KEY_SIZE]);
/** @brief Stage a raw Control key, including all-zero bytes; null clears it. */
void zf_boot_config_set_ble_key(const uint8_t key[ZF_BLE_KEY_SIZE]);
/** @brief Return whether a Control key is staged, independently of its raw byte values. */
bool zf_boot_config_ble_key_configured(void);

/** @brief Report whether saved wireless settings differ from the values loaded at boot. */
bool zf_boot_config_wireless_restart_required(void);
/** @brief Report whether any saved setting differs from the values loaded at boot. */
bool zf_boot_config_restart_required(void);

/**
 * @brief Persist the staged configuration as one record.
 *
 * Clock profile, radio switches and credentials share one CRC-protected record. This single-copy write is not
 * power-loss atomic: interrupted erase/program can destroy the old record. Boot loads a valid record or defaults.
 * @return 0 when unchanged or when the write and readback succeeded, otherwise a negative errno. On failure the
 * staged values are discarded so the RAM copy matches the last confirmed record; flash may already have changed.
 * Callers may re-stage.
 */
int zf_boot_config_save(void);
/** @brief Drop all staged, unsaved values, restoring the last loaded or saved configuration. */
void zf_boot_config_discard(void);

/**
 * @brief Serialize the staged configuration into a record, including its CRC.
 * @param record Output buffer of ZF_BOOT_CONFIG_RECORD_SIZE bytes.
 */
void zf_boot_config_encode(uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE]);
/** @brief Return the IEEE CRC-32 (reflected) used by the record. */
uint32_t zf_boot_config_crc32(const uint8_t *data, size_t size);

#endif
