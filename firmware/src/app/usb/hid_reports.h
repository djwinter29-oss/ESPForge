/**
 * @file hid_reports.h
 * @brief Encoders for the ESPForge HID/GATT report payloads.
 *
 * Payloads exclude the USB report ID. Portable: the Zephyr glue samples the board and fills these structs.
 */
#ifndef ESPFORGE_HID_REPORTS_H
#define ESPFORGE_HID_REPORTS_H

#include <stdbool.h>
#include <stdint.h>

#define EF_REPORT_IDENTITY 1u
#define EF_REPORT_CONFIG 2u
#define EF_REPORT_TELEMETRY 3u
#define EF_REPORT_STORAGE 10u
#define EF_REPORT_BENCHMARK 11u
#define EF_REPORT_WIRELESS 12u
#define EF_REPORT_CONTROL 20u

#define EF_IDENTITY_SIZE 26u
#define EF_CONFIG_SIZE 17u
#define EF_TELEMETRY_SIZE 22u
#define EF_STORAGE_SIZE 34u
#define EF_WIRELESS_SIZE 48u
#define EF_CONTROL_SIZE 68u
#define EF_BLE_CONTROL_SIZE 9u

#define EF_PRODUCT_ID 0x0003u
#define EF_MCU_ESP32S3 3u
#define EF_BOARD_DEVKITC 1u

#define EF_CAP_LED 0x01u
#define EF_CAP_REBOOT 0x02u
#define EF_CAP_SETTINGS 0x04u
#define EF_CAP_SDMMC 0x10u
#define EF_CAP_WIRELESS 0x80u
#define EF_CAPABILITIES (EF_CAP_REBOOT | EF_CAP_SETTINGS | EF_CAP_SDMMC | EF_CAP_WIRELESS)

#define EF_UID_SIZE 8u
#define EF_SSID_MAX 32u
#define EF_LOAD_UNAVAILABLE 0xFFFFu
#define EF_GPIO_UNASSIGNED 0xFFu
/** Report 2 board flag: native USB mass storage with explicit owner handoff is available. */
#define EF_CONFIG_FLAG_MSC 0x40u

typedef struct {
	uint8_t uid[EF_UID_SIZE];
	uint8_t firmware[3];
	uint32_t ram_total_bytes;
	uint32_t ram_reserved_bytes;
} ef_identity_t;

typedef struct {
	uint16_t stored_clock_mhz;
	uint8_t stored_radios; /**< EF_WIRELESS_WIFI / EF_WIRELESS_BLE bits. */
	uint8_t reset_cause;
	bool card_detect_available; /**< A physical card-present GPIO is allocated. */
	uint8_t card_detect_gpio; /**< Board card-present input, valid when allocated. */
	bool msc_supported; /**< Native USB mass-storage class is enabled. */
} ef_config_t;

typedef struct {
	bool temperature_valid;
	int16_t temperature_centi_c;
	uint64_t uptime_ms;
	uint16_t core0_load;
	uint32_t system_clock_hz;
	uint8_t sequence;
	bool usb_configured;
} ef_telemetry_t;

/** Coherent storage snapshot; invalid samples carry no live SD fields on the wire. */
typedef struct {
	uint8_t sequence; /**< Published Input sequence. */
	bool configured; /**< Card detection and storage service are configured. */
	bool presence_known; /**< Debounced presence is known. */
	bool present; /**< Debounced card-present state. */
	bool sample_valid; /**< Firmware-owned, non-busy SD sample is available. */
	bool initialized; /**< The current medium was initialized successfully. */
	bool capacity_valid; /**< Sector count belongs to the current medium. */
	uint32_t bus_clock_hz; /**< Configured bus ceiling, not a measured clock. */
	uint32_t block_count; /**< Whole-card capacity in 512-byte sectors. */
	uint8_t filesystem_format; /**< Mounted FAT format, or zero when unknown. */
	bool msc_enabled; /**< USB exclusively owns the raw medium. */
	bool msc_transition_pending; /**< An admitted ownership handoff is pending. */
	bool msc_request_rejected; /**< Last admitted handoff failed or was cancelled. */
	bool busy; /**< Storage worker is manipulating the medium; not encoded separately. */
} ef_storage_t;

typedef struct {
	uint8_t wifi_state;
	uint8_t detail;
	uint8_t ble_state;
	uint8_t flags;
	uint8_t ipv4[4];
	uint8_t ssid_length;
	uint8_t ssid[EF_SSID_MAX];
	uint8_t scan_state;
	uint16_t scan_generation;
	uint8_t scan_count;
	uint8_t test_generation;
	uint8_t staged_state;
} ef_wireless_t;

void ef_report_identity(const ef_identity_t *identity, uint8_t out[EF_IDENTITY_SIZE]);
void ef_report_config(const ef_config_t *config, uint8_t out[EF_CONFIG_SIZE]);
void ef_report_telemetry(const ef_telemetry_t *telemetry, uint8_t out[EF_TELEMETRY_SIZE]);
void ef_report_storage(const ef_storage_t *storage, uint8_t out[EF_STORAGE_SIZE]);
void ef_report_wireless(const ef_wireless_t *wireless, uint8_t out[EF_WIRELESS_SIZE]);

/** Format the UID as the 16-character uppercase hex USB serial string, NUL-terminated. */
void ef_uid_hex(const uint8_t uid[EF_UID_SIZE], char out[2 * EF_UID_SIZE + 1]);

/** Map Zephyr hwinfo reset-cause bits to the Report 2 enum. */
uint8_t ef_reset_cause(uint32_t hwinfo_cause);

/** Service load in basis points from busy and total cycle deltas; EF_LOAD_UNAVAILABLE without a window. */
uint16_t ef_load_basis_points(uint64_t busy_cycles, uint64_t total_cycles);

#endif
