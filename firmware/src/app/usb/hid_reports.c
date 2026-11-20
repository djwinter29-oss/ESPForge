#include "app/usb/hid_reports.h"
#include "platform/boot_config.h"

#include <string.h>

/* Zephyr hwinfo reset-cause bits (include/zephyr/drivers/hwinfo.h). */
#define HWINFO_RESET_SOFTWARE 0x02u
#define HWINFO_RESET_POR 0x08u
#define HWINFO_RESET_WATCHDOG 0x10u

/* DevKitC monitor UART0. */
#define MONITOR_UART_INDEX 0u
#define MONITOR_UART_TX 43u
#define MONITOR_UART_RX 44u

/* Report 2 board_flags bits; bit 5, the reserved TCP CLI switch, stays clear. */
#define BOARD_FLAG_CARD_DETECT 0x01u
#define BOARD_FLAG_LED 0x02u
#define BOARD_FLAG_MONITOR_UART 0x04u
#define BOARD_FLAG_WIFI 0x08u
#define BOARD_FLAG_BLE 0x10u
#define BOARD_FLAG_MSC 0x40u

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

void zf_report_identity(const zf_identity_t *identity, uint8_t out[ZF_IDENTITY_SIZE])
{
	memset(out, 0, ZF_IDENTITY_SIZE);
	out[0] = 1;
	put16(out + 1, ZF_PRODUCT_ID);
	memcpy(out + 3, identity->uid, ZF_UID_SIZE);
	memcpy(out + 11, identity->firmware, 3);
	out[14] = ZF_MCU_ESP32S3;
	out[15] = ZF_BOARD_DEVKITC;
	out[16] = ZF_EXT_MEMORY;
	out[17] = ZF_CAPABILITIES;
	put32(out + 18, identity->ram_total_bytes);
	put32(out + 22, identity->ram_reserved_bytes);
}

void zf_report_memory(const zf_memory_inventory_t *memory, uint8_t out[ZF_MEMORY_SIZE])
{
	memset(out, 0, ZF_MEMORY_SIZE);
	out[0] = 1;
	out[1] = (memory->psram_available ? 1u : 0u) | (memory->flash_available ? 2u : 0u);
	if (memory->psram_available) {
		put32(out + 4, memory->psram_total_bytes);
		put32(out + 8, memory->psram_reserved_bytes);
	}
	if (memory->flash_available) {
		put32(out + 12, memory->flash_total_bytes);
	}
}

void zf_report_config(const zf_config_t *config, uint8_t out[ZF_CONFIG_SIZE])
{
	uint8_t flags = BOARD_FLAG_MONITOR_UART;

	if (config->led_available) {
		flags |= BOARD_FLAG_LED;
	}
	if (config->card_detect_available) {
		flags |= BOARD_FLAG_CARD_DETECT;
	}
	if (config->msc_supported) {
		flags |= BOARD_FLAG_MSC;
	}
	if (config->stored_radios & ZF_WIRELESS_WIFI) {
		flags |= BOARD_FLAG_WIFI;
	}
	if (config->stored_radios & ZF_WIRELESS_BLE) {
		flags |= BOARD_FLAG_BLE;
	}
	memset(out, 0, ZF_CONFIG_SIZE);
	out[0] = 1;
	put16(out + 1, config->stored_clock_mhz);
	out[3] = 0;
	out[4] = MONITOR_UART_INDEX;
	out[5] = MONITOR_UART_TX;
	out[6] = MONITOR_UART_RX;
	memcpy(out + 7, config->storage_gpios, sizeof(config->storage_gpios));
	out[13] = flags;
	out[14] = config->reset_cause;
	out[15] = config->led_available ? config->led_gpio : ZF_GPIO_UNASSIGNED;
	out[16] = config->card_detect_available ? config->card_detect_gpio : ZF_GPIO_UNASSIGNED;
}

void zf_report_telemetry(const zf_telemetry_t *telemetry, uint8_t out[ZF_TELEMETRY_SIZE])
{
	memset(out, 0, ZF_TELEMETRY_SIZE);
	out[0] = 1;
	out[1] = telemetry->led_available ? telemetry->led_colour : 0;
	if (telemetry->temperature_valid) {
		put16(out + 2, (uint16_t)telemetry->temperature_centi_c);
	}
	put32(out + 4, (uint32_t)telemetry->uptime_ms);
	put32(out + 8, (uint32_t)(telemetry->uptime_ms >> 32));
	put16(out + 12, telemetry->core0_load);
	put16(out + 14, ZF_LOAD_UNAVAILABLE);
	put32(out + 16, telemetry->system_clock_hz);
	out[20] = telemetry->sequence;
	out[21] = (uint8_t)((telemetry->usb_configured ? 0x01u : 0) | (telemetry->temperature_valid ? 0x04u : 0) |
			   (telemetry->led_available ? 0x08u : 0));
}

void zf_report_storage(const zf_storage_t *storage, uint8_t out[ZF_STORAGE_SIZE])
{
	uint8_t sd_flags = storage->configured ? 0x01u : 0;
	bool valid = storage->sample_valid && !storage->msc_enabled && !storage->msc_transition_pending;

	memset(out, 0, ZF_STORAGE_SIZE);
	out[0] = 1;
	out[1] = storage->sequence;
	if (valid) {
		sd_flags |= 0x40u;
		if (storage->presence_known) {
			sd_flags |= 0x02u;
		}
		if (storage->present) {
			sd_flags |= 0x04u;
		}
	}
	if (valid && storage->initialized) {
		sd_flags |= 0x08u;
		if (storage->cid_valid) {
			sd_flags |= 0x10u;
			memcpy(out + 14, storage->cid, sizeof(storage->cid));
		}
		if (storage->capacity_valid) {
			sd_flags |= 0x20u;
			put32(out + 10, storage->block_count);
		}
		out[3] = 1;
		out[4] = ZF_STORAGE_SPI ? 2 : 3;
		put32(out + 5, storage->bus_clock_hz);
		out[9] = 1;
	}
	out[2] = sd_flags;
	out[30] = storage->filesystem_format <= 4 ? storage->filesystem_format : 0;
	out[31] = storage->msc_enabled;
	out[32] = storage->msc_transition_pending;
	out[33] = storage->msc_request_rejected;
}

void zf_report_benchmark(const zf_benchmark_t *status, uint8_t out[ZF_BENCHMARK_SIZE])
{
	memset(out, 0, ZF_BENCHMARK_SIZE);
	out[0] = 1;
	out[1] = status->sequence;
	out[2] = status->state;
	out[3] = status->flags;
	put32(out + 4, status->target_bytes);
	put32(out + 8, status->written_bytes);
	put32(out + 12, status->read_bytes);
	put32(out + 16, status->write_elapsed_ms);
	put32(out + 20, status->read_elapsed_ms);
	put32(out + 24, status->mismatch_count);
	out[28] = status->state == ZF_BENCHMARK_FAILED ? status->error : 0;
	out[29] = status->state == ZF_BENCHMARK_FAILED ? status->filesystem_result : 0;
}

void zf_report_wireless(const zf_wireless_t *wireless, uint8_t out[ZF_WIRELESS_SIZE])
{
	uint8_t length = wireless->ssid_length <= ZF_SSID_MAX_BYTES
		? wireless->ssid_length : ZF_SSID_MAX_BYTES;

	memset(out, 0, ZF_WIRELESS_SIZE);
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

void zf_uid_hex(const uint8_t uid[ZF_UID_SIZE], char out[2 * ZF_UID_SIZE + 1])
{
	static const char digits[] = "0123456789ABCDEF";

	for (unsigned i = 0; i < ZF_UID_SIZE; ++i) {
		out[2 * i] = digits[uid[i] >> 4];
		out[2 * i + 1] = digits[uid[i] & 0x0Fu];
	}
	out[2 * ZF_UID_SIZE] = '\0';
}

uint8_t zf_reset_cause(uint32_t hwinfo_cause)
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

uint16_t zf_load_basis_points(uint64_t busy_cycles, uint64_t total_cycles)
{
	if (total_cycles == 0) {
		return ZF_LOAD_UNAVAILABLE;
	}
	if (busy_cycles >= total_cycles) {
		return 10000u;
	}
	return (uint16_t)((busy_cycles * 10000u) / total_cycles);
}
