#include "app/usb/hid_reports.h"
#include "platform/boot_config.h"

#include <string.h>

/* Zephyr hwinfo reset-cause bits (include/zephyr/drivers/hwinfo.h). */
#define HWINFO_RESET_SOFTWARE 0x02u
#define HWINFO_RESET_POR 0x08u
#define HWINFO_RESET_WATCHDOG 0x10u

/* DevKitC monitor UART0 and native SDMMC pins; see docs/reference/sdcard.md. */
#define MONITOR_UART_INDEX 0u
#define MONITOR_UART_TX 43u
#define MONITOR_UART_RX 44u
static const uint8_t storage_gpios[6] = {12u, 11u, 13u, 14u, 15u, 10u};

#define CONFIG_FLAG_MONITOR_UART 0x04u
#define CONFIG_FLAG_WIFI 0x08u
#define CONFIG_FLAG_BLE 0x10u

static void put16(uint8_t *out, uint16_t value)
{
	out[0] = (uint8_t)value;
	out[1] = (uint8_t)(value >> 8);
}

static void put32(uint8_t *out, uint32_t value)
{
	put16(out, (uint16_t)value);
	put16(out + 2, (uint16_t)(value >> 16));
}

void ef_report_identity(const ef_identity_t *identity, uint8_t out[EF_IDENTITY_SIZE])
{
	memset(out, 0, EF_IDENTITY_SIZE);
	out[0] = 1;
	put16(out + 1, EF_PRODUCT_ID);
	memcpy(out + 3, identity->uid, EF_UID_SIZE);
	memcpy(out + 11, identity->firmware, 3);
	out[14] = EF_MCU_ESP32S3;
	out[15] = EF_BOARD_DEVKITC;
	out[16] = 0;
	out[17] = EF_CAPABILITIES;
	put32(out + 18, identity->ram_total_bytes);
	put32(out + 22, identity->ram_reserved_bytes);
}

void ef_report_config(const ef_config_t *config, uint8_t out[EF_CONFIG_SIZE])
{
	uint8_t flags = CONFIG_FLAG_MONITOR_UART;

	if (config->stored_radios & EF_WIRELESS_WIFI) {
		flags |= CONFIG_FLAG_WIFI;
	}
	if (config->stored_radios & EF_WIRELESS_BLE) {
		flags |= CONFIG_FLAG_BLE;
	}
	memset(out, 0, EF_CONFIG_SIZE);
	out[0] = 1;
	put16(out + 1, config->stored_clock_mhz);
	out[3] = 0;
	out[4] = MONITOR_UART_INDEX;
	out[5] = MONITOR_UART_TX;
	out[6] = MONITOR_UART_RX;
	memcpy(out + 7, storage_gpios, sizeof(storage_gpios));
	out[13] = flags;
	out[14] = config->reset_cause;
	out[15] = EF_GPIO_UNASSIGNED;
	out[16] = EF_GPIO_UNASSIGNED;
}

void ef_report_telemetry(const ef_telemetry_t *telemetry, uint8_t out[EF_TELEMETRY_SIZE])
{
	memset(out, 0, EF_TELEMETRY_SIZE);
	out[0] = 1;
	out[1] = 0;
	if (telemetry->temperature_valid) {
		put16(out + 2, (uint16_t)telemetry->temperature_centi_c);
	}
	put32(out + 4, (uint32_t)telemetry->uptime_ms);
	put32(out + 8, (uint32_t)(telemetry->uptime_ms >> 32));
	put16(out + 12, telemetry->core0_load);
	put16(out + 14, EF_LOAD_UNAVAILABLE);
	put32(out + 16, telemetry->system_clock_hz);
	out[20] = telemetry->sequence;
	out[21] = (uint8_t)((telemetry->usb_configured ? 0x01u : 0) | (telemetry->temperature_valid ? 0x04u : 0));
}

void ef_report_storage(const ef_storage_t *storage, uint8_t out[EF_STORAGE_SIZE])
{
	/* Storage is configured and every published sample is valid; no card-detect input exists. */
	uint8_t sd_flags = 0x01u | 0x40u;

	memset(out, 0, EF_STORAGE_SIZE);
	out[0] = 1;
	out[1] = storage->sequence;
	if (storage->initialized) {
		sd_flags |= 0x02u | 0x04u | 0x08u;
		if (storage->capacity_valid) {
			sd_flags |= 0x20u;
			put32(out + 10, storage->block_count);
		}
		out[3] = 1;
		out[4] = 3;
		put32(out + 5, storage->bus_clock_hz);
		out[9] = 1;
	}
	out[2] = sd_flags;
	out[30] = storage->filesystem_format <= 4 ? storage->filesystem_format : 0;
}

void ef_report_wireless(const ef_wireless_t *wireless, uint8_t out[EF_WIRELESS_SIZE])
{
	uint8_t length = wireless->ssid_length <= EF_SSID_MAX ? wireless->ssid_length : EF_SSID_MAX;

	memset(out, 0, EF_WIRELESS_SIZE);
	out[0] = 1;
	out[1] = wireless->wifi_state;
	out[2] = wireless->detail;
	out[3] = wireless->ble_state;
	out[4] = (uint8_t)(wireless->flags & ~0x0Cu);
	memcpy(out + 5, wireless->ipv4, 4);
	out[9] = length;
	memcpy(out + 10, wireless->ssid, length);
	out[42] = wireless->scan_state;
	put16(out + 43, wireless->scan_generation);
	out[45] = wireless->scan_count;
	out[46] = wireless->test_generation;
	out[47] = wireless->staged_state;
}

void ef_uid_hex(const uint8_t uid[EF_UID_SIZE], char out[2 * EF_UID_SIZE + 1])
{
	static const char digits[] = "0123456789ABCDEF";

	for (unsigned i = 0; i < EF_UID_SIZE; ++i) {
		out[2 * i] = digits[uid[i] >> 4];
		out[2 * i + 1] = digits[uid[i] & 0x0Fu];
	}
	out[2 * EF_UID_SIZE] = '\0';
}

uint8_t ef_reset_cause(uint32_t hwinfo_cause)
{
	if (hwinfo_cause & HWINFO_RESET_POR) {
		return 1;
	}
	if (hwinfo_cause & HWINFO_RESET_WATCHDOG) {
		return 2;
	}
	if (hwinfo_cause & HWINFO_RESET_SOFTWARE) {
		return 3;
	}
	return 0;
}

uint16_t ef_load_basis_points(uint64_t busy_cycles, uint64_t total_cycles)
{
	if (total_cycles == 0) {
		return EF_LOAD_UNAVAILABLE;
	}
	if (busy_cycles >= total_cycles) {
		return 10000u;
	}
	return (uint16_t)((busy_cycles * 10000u) / total_cycles);
}
