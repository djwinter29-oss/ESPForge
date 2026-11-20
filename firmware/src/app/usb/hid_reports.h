/**
 * @file hid_reports.h
 * @brief Encoders for the ZephyrForge HID/GATT report payloads.
 *
 * Payloads exclude the USB report ID. Portable: the Zephyr glue samples the board and fills these structs.
 */
#ifndef ZEPHYRFORGE_HID_REPORTS_H
#define ZEPHYRFORGE_HID_REPORTS_H

#include <stdbool.h>
#include <stdint.h>
#include "app/storage/benchmark.h"
#include "wireless_limits.h"

#define ZF_REPORT_IDENTITY 1u
#define ZF_REPORT_CONFIG 2u
#define ZF_REPORT_TELEMETRY 3u
#define ZF_REPORT_STORAGE 10u
#define ZF_REPORT_BENCHMARK 11u
#define ZF_REPORT_WIRELESS 12u
/** Read-only boot memory inventory Feature report. */
#define ZF_REPORT_MEMORY 13u
#define ZF_REPORT_CONTROL 20u

#define ZF_IDENTITY_SIZE 26u
#define ZF_CONFIG_SIZE 17u
#define ZF_TELEMETRY_SIZE 22u
#define ZF_STORAGE_SIZE 34u
/** Benchmark Input payload size, excluding report ID. */
#define ZF_BENCHMARK_SIZE 32u
#define ZF_WIRELESS_SIZE 48u
/** Memory inventory payload size, excluding report ID. */
#define ZF_MEMORY_SIZE 16u
/** Identity extension flag: Report 13 memory inventory is available. */
#define ZF_EXT_MEMORY 0x01u
#define ZF_CONTROL_SIZE 68u
#define ZF_BLE_CONTROL_SIZE 9u

#define ZF_PRODUCT_ID 0x0003u
#define ZF_MCU_ESP32S3 3u
#define ZF_BOARD_DEVKITC 1u

#define ZF_CAP_LED 0x01u
#define ZF_CAP_REBOOT 0x02u
#define ZF_CAP_SETTINGS 0x04u
/** SD memory-card transport over SPI, mutually exclusive with native SDMMC. */
#define ZF_CAP_SPI 0x08u
#define ZF_CAP_SDMMC 0x10u
/** Build-selected storage transport; portable tests default to native SDMMC. */
#ifndef ZF_STORAGE_SPI
#define ZF_STORAGE_SPI 0
#endif
/** Exactly one storage capability is advertised by each firmware image. */
#define ZF_CAP_STORAGE (ZF_STORAGE_SPI ? ZF_CAP_SPI : ZF_CAP_SDMMC)
/** Optional temporary-file benchmark capability. */
#define ZF_CAP_BENCHMARK 0x20u
#define ZF_CAP_WIRELESS 0x80u
#define ZF_CAPABILITIES (ZF_CAP_LED | ZF_CAP_REBOOT | ZF_CAP_SETTINGS | ZF_CAP_STORAGE | ZF_CAP_WIRELESS | \
			(ZF_ENABLE_STORAGE_BENCHMARK ? ZF_CAP_BENCHMARK : 0))

#define ZF_UID_SIZE 8u
#define ZF_LOAD_UNAVAILABLE 0xFFFFu
#define ZF_GPIO_UNASSIGNED 0xFFu

typedef struct {
	uint8_t uid[ZF_UID_SIZE];
	uint8_t firmware[3];
	uint32_t ram_total_bytes;
	uint32_t ram_reserved_bytes;
} zf_identity_t;

/** Boot-sampled physical capacities and linker-reserved external RAM, not live heap usage. */
typedef struct {
	bool psram_available; /**< PSRAM initialization succeeded. */
	bool flash_available; /**< Module flash capacity was read successfully. */
	uint32_t psram_total_bytes; /**< Detected PSRAM chip capacity. */
	uint32_t psram_reserved_bytes; /**< Linked PSRAM regions, including permanent heap pools. */
	uint32_t flash_total_bytes; /**< Detected module SPI flash capacity; not free filesystem space. */
} zf_memory_inventory_t;

/** Saved configuration and hardware pin allocation. */
typedef struct {
	uint16_t stored_clock_mhz; /**< Next-boot clock profile in MHz; zero selects the build default. */
	uint8_t stored_radios; /**< ZF_WIRELESS_WIFI / ZF_WIRELESS_BLE bits. */
	uint8_t reset_cause; /**< Boot-sampled reset reason in the management wire enum. */
	bool card_detect_available; /**< A physical card-present GPIO is allocated. */
	uint8_t card_detect_gpio; /**< Board card-present input, valid when allocated. */
	bool msc_supported; /**< Native USB mass-storage class is enabled. */
	bool led_available; /**< Addressable RGB LED is allocated in hardware configuration. */
	uint8_t led_gpio; /**< LED data pin, valid when allocated. */
	uint8_t storage_gpios[6]; /**< Native CLK/CMD/DAT0-DAT3 or SPI SCK/MOSI/MISO/CS/255/255. */
} zf_config_t;

typedef struct {
	bool temperature_valid;
	int16_t temperature_centi_c;
	uint64_t uptime_ms;
	uint16_t core0_load;
	uint32_t system_clock_hz;
	uint8_t sequence;
	bool usb_configured;
	bool led_available; /**< Last LED transmission succeeded. */
	uint8_t led_colour; /**< Last transmitted RGB bitmask: red=1, green=2, blue=4. */
} zf_telemetry_t;

/** Coherent storage snapshot; invalid samples carry no live SD fields on the wire. */
typedef struct {
	uint8_t sequence; /**< Published Input sequence. */
	bool configured; /**< Card detection and storage service are configured. */
	bool presence_known; /**< Debounced presence is known. */
	bool present; /**< Debounced card-present state. */
	bool sample_valid; /**< Firmware-owned, non-busy SD sample is available. */
	bool initialized; /**< Hardware initialization succeeded, independently of filesystem mounting. */
	bool capacity_valid; /**< Sector count belongs to the current medium. */
	bool cid_valid; /**< CID belongs to the initialized current medium. */
	uint8_t cid[16]; /**< Raw SD CID in wire byte order. */
	uint32_t bus_clock_hz; /**< Configured bus ceiling, not a measured clock. */
	uint32_t block_count; /**< Whole-card capacity in 512-byte sectors. */
	uint8_t filesystem_format; /**< Mounted FAT format, or zero when unknown. */
	bool msc_enabled; /**< USB exclusively owns the raw medium. */
	bool msc_transition_pending; /**< An admitted ownership handoff is pending. */
	bool msc_request_rejected; /**< Last admitted handoff failed or was cancelled. */
	bool busy; /**< Storage worker is manipulating the medium; not encoded separately. */
} zf_storage_t;

typedef struct {
	uint8_t wifi_state;
	uint8_t detail;
	uint8_t ble_state;
	uint8_t flags;
	uint8_t ipv4[4];
	uint8_t ssid_length;
	uint8_t ssid[ZF_SSID_MAX_BYTES];
	uint8_t scan_state;
	uint16_t scan_generation;
	uint8_t scan_count;
	uint8_t test_generation;
	uint8_t staged_state;
} zf_wireless_t;

void zf_report_identity(const zf_identity_t *identity, uint8_t out[ZF_IDENTITY_SIZE]);
/** Encode the boot memory inventory; unavailable components have zero wire values. */
void zf_report_memory(const zf_memory_inventory_t *memory, uint8_t out[ZF_MEMORY_SIZE]);
void zf_report_config(const zf_config_t *config, uint8_t out[ZF_CONFIG_SIZE]);
void zf_report_telemetry(const zf_telemetry_t *telemetry, uint8_t out[ZF_TELEMETRY_SIZE]);
void zf_report_storage(const zf_storage_t *storage, uint8_t out[ZF_STORAGE_SIZE]);
/** Encode a coherent benchmark snapshot. */
void zf_report_benchmark(const zf_benchmark_t *status, uint8_t out[ZF_BENCHMARK_SIZE]);
void zf_report_wireless(const zf_wireless_t *wireless, uint8_t out[ZF_WIRELESS_SIZE]);

/** Format the UID as the 16-character uppercase hex USB serial string, NUL-terminated. */
void zf_uid_hex(const uint8_t uid[ZF_UID_SIZE], char out[2 * ZF_UID_SIZE + 1]);

/** Map Zephyr hwinfo reset-cause bits to the Report 2 enum. */
uint8_t zf_reset_cause(uint32_t hwinfo_cause);

/** Service load in basis points from busy and total cycle deltas; ZF_LOAD_UNAVAILABLE without a window. */
uint16_t zf_load_basis_points(uint64_t busy_cycles, uint64_t total_cycles);

#endif
