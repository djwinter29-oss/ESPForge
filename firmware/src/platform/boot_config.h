/**
 * @file boot_config.h
 * @brief Boot settings loaded at the start of main(), then owned by the main (management) thread.
 *
 * Adapted from PicoForge's platform/boot_config.h. One CRC-protected record in the `storage_partition` holds the
 * system clock profile, radio switches and credentials. Setters stage values in RAM; ef_boot_config_save() commits
 * them as one unit. Saved values apply at the next boot only.
 *
 * This API is not thread-safe. Call ef_boot_config_load() once before other threads use settings; afterwards all
 * mutations and saves must be serialized in the main thread, which is the single writer of the settings record.
 */

#ifndef ESPFORGE_BOOT_CONFIG_H
#define ESPFORGE_BOOT_CONFIG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Wi-Fi radio master-switch bit. */
#define EF_WIRELESS_WIFI 1u
/** BLE radio master-switch bit. */
#define EF_WIRELESS_BLE 2u
/** NUL-terminated SSID storage size, including its terminator. */
#define EF_WIFI_SSID_SIZE 33u
/** NUL-terminated passphrase storage size, including its terminator. */
#define EF_WIFI_PASSWORD_SIZE 64u
/** Control key size in bytes. */
#define EF_BLE_KEY_SIZE 32u
/** Serialized record size in bytes. */
#define EF_BOOT_CONFIG_RECORD_SIZE 148u

/** Saved Wi-Fi authentication state: unknown modes are probed, confirmed modes persist across reboot. */
typedef enum {
	EF_WIFI_AUTH_TRY_WPA2 = 0, /**< Mode unknown; try WPA2 first. */
	EF_WIFI_AUTH_TRY_SAE = 1,  /**< Mode unknown; try WPA3-SAE. */
	EF_WIFI_AUTH_WPA2 = 2,     /**< WPA2 connection was confirmed. */
	EF_WIFI_AUTH_SAE = 3,      /**< WPA3-SAE connection was confirmed. */
} ef_wifi_auth_state_t;

/** User-selected CPU clock profile; flash stores its ID, while host protocols carry MHz. */
typedef enum {
	EF_SYSCLK_DEFAULT = 0, /**< Keep the devicetree/build clock (240 MHz); used when nothing is saved. */
	EF_SYSCLK_80MHZ = 1,   /**< 80 MHz. */
	EF_SYSCLK_160MHZ = 2,  /**< 160 MHz. */
	EF_SYSCLK_240MHZ = 3,  /**< 240 MHz. */
} ef_sysclk_profile_t;

/** Where the RAM copy came from at the last load. */
typedef enum {
	EF_BOOT_CONFIG_NOT_LOADED = 0, /**< ef_boot_config_load() has not run; defaults are in use. */
	EF_BOOT_CONFIG_DEFAULTS = 1,   /**< The record is erased or invalid; defaults are in use. */
	EF_BOOT_CONFIG_SAVED = 2,      /**< A valid saved record was loaded. */
	EF_BOOT_CONFIG_READ_ERROR = 3, /**< Flash could not be read; defaults are in use. */
} ef_boot_config_source_t;

/**
 * @brief Convert a CPU clock profile to MHz.
 * @return 0 (keep the build clock) for EF_SYSCLK_DEFAULT or an unknown profile, otherwise 80, 160 or 240.
 */
static inline uint16_t ef_sysclk_profile_mhz(ef_sysclk_profile_t profile)
{
	static const uint16_t mhz[] = {0u, 80u, 160u, 240u};

	return (unsigned)profile < sizeof(mhz) / sizeof(mhz[0]) ? mhz[profile] : 0u;
}

/**
 * @brief Convert a protocol MHz value to a CPU clock profile.
 * @return The matching profile, or an out-of-range profile rejected by ef_boot_config_set_sysclk().
 */
static inline ef_sysclk_profile_t ef_sysclk_profile_from_mhz(uint16_t mhz)
{
	unsigned profile = EF_SYSCLK_DEFAULT;

	while (profile <= EF_SYSCLK_240MHZ && ef_sysclk_profile_mhz((ef_sysclk_profile_t)profile) != mhz) {
		++profile;
	}
	return (ef_sysclk_profile_t)profile;
}

/**
 * @brief Read and validate the saved record, replacing the RAM copy and the boot snapshot.
 *
 * An erased, invalid or unreadable record loads complete defaults: every radio allowed, the build clock, and no
 * credentials. Boot never depends on flash succeeding.
 */
void ef_boot_config_load(void);
/** @brief Report where the current RAM copy came from. */
ef_boot_config_source_t ef_boot_config_source(void);

/** @brief Return the staged CPU clock profile. */
ef_sysclk_profile_t ef_boot_config_sysclk(void);
/**
 * @brief Stage a CPU clock profile; persist with ef_boot_config_save(), applied at the next boot.
 * @return false (configuration unchanged) for an unknown profile.
 */
bool ef_boot_config_set_sysclk(ef_sysclk_profile_t profile);
/** @brief Return the CPU clock profile loaded at boot, which is the one the running firmware applied. */
ef_sysclk_profile_t ef_boot_config_boot_sysclk(void);

/** @brief Return the staged EF_WIRELESS_* radios allowed to start at boot; both by default. */
uint8_t ef_boot_config_radios(void);
/**
 * @brief Stage the EF_WIRELESS_* radio switches; persist with ef_boot_config_save(), applied at the next boot.
 * @return false (configuration unchanged) for unknown bits.
 */
bool ef_boot_config_set_radios(uint8_t radios);
/** @brief Return the radios loaded at boot, which are the ones the running firmware started. */
uint8_t ef_boot_config_boot_radios(void);

/**
 * @brief Copy the staged SSID into a 33-byte buffer, with a final terminator.
 *
 * Opaque SSIDs may contain embedded zeros; use the byte getter for network identity.
 */
void ef_boot_config_wifi_ssid(char ssid[EF_WIFI_SSID_SIZE]);
/**
 * @brief Stage an SSID string; an empty string clears it.
 * @return false for null or a string longer than 32 bytes.
 */
bool ef_boot_config_set_wifi_ssid(const char *ssid);
/**
 * @brief Copy the staged opaque SSID, zero padded to 32 bytes.
 * @return Saved byte length, including embedded zero bytes.
 */
uint8_t ef_boot_config_wifi_ssid_bytes(uint8_t ssid[32]);
/**
 * @brief Stage an opaque SSID without text conversion.
 * @param ssid Bytes to copy; may be null only when length is zero.
 * @param length Byte length, zero through 32.
 */
bool ef_boot_config_set_wifi_ssid_bytes(const uint8_t *ssid, uint8_t length);
/** @brief Copy the staged private passphrase; never expose it in a host report. */
void ef_boot_config_wifi_password(char password[EF_WIFI_PASSWORD_SIZE]);
/**
 * @brief Stage a passphrase; empty clears it, otherwise it must be 8-63 non-NUL bytes (UTF-8 is accepted).
 * @return false for null or an invalid passphrase.
 */
bool ef_boot_config_set_wifi_password(const char *password);
/** @brief Return whether a Wi-Fi passphrase is staged, without copying it. */
bool ef_boot_config_wifi_password_configured(void);
/** @brief Return the staged Wi-Fi authentication state; erased or invalid settings try WPA2. */
ef_wifi_auth_state_t ef_boot_config_wifi_auth_state(void);
/** @brief Stage the Wi-Fi authentication state; false for an unknown state. */
bool ef_boot_config_set_wifi_auth_state(ef_wifi_auth_state_t state);

/** @brief Copy the staged private BLE Control key; never expose it in a host report. */
void ef_boot_config_ble_key(uint8_t key[EF_BLE_KEY_SIZE]);
/** @brief Stage a raw Control key, including all-zero bytes; null clears it. */
void ef_boot_config_set_ble_key(const uint8_t key[EF_BLE_KEY_SIZE]);
/** @brief Return whether a Control key is staged, independently of its raw byte values. */
bool ef_boot_config_ble_key_configured(void);

/** @brief Report whether saved wireless settings differ from the values loaded at boot. */
bool ef_boot_config_wireless_restart_required(void);
/** @brief Report whether any saved setting differs from the values loaded at boot. */
bool ef_boot_config_restart_required(void);

/**
 * @brief Persist the staged configuration as one record.
 *
 * Clock profile, radio switches and credentials are committed as one unit: an interrupted write loads either the
 * complete new configuration or defaults.
 * @return 0 when unchanged or when the write and readback succeeded, otherwise a negative errno. On failure the
 * staged values are discarded so the RAM copy matches the last confirmed record; callers may re-stage.
 */
int ef_boot_config_save(void);
/** @brief Drop all staged, unsaved values, restoring the last loaded or saved configuration. */
void ef_boot_config_discard(void);

/**
 * @brief Serialize the staged configuration into a record, including its CRC.
 * @param record Output buffer of EF_BOOT_CONFIG_RECORD_SIZE bytes.
 */
void ef_boot_config_encode(uint8_t record[EF_BOOT_CONFIG_RECORD_SIZE]);
/** @brief Return the IEEE CRC-32 (reflected) used by the record. */
uint32_t ef_boot_config_crc32(const uint8_t *data, size_t size);

#endif
