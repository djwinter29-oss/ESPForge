#include "unity.h"
#include "hid_reports.h"

#include <string.h>

void test_benchmark_layout_and_nonterminal_error_suppression(void)
{
	ef_benchmark_t status = {.sequence = 9, .state = EF_BENCHMARK_FAILED, .flags = EF_BENCHMARK_FILE_REMAINS,
				.target_bytes = 0x00100000, .written_bytes = 0x01020304,
				.error = EF_BENCHMARK_ERROR_IO, .filesystem_result = 1};
	const uint8_t expected[EF_BENCHMARK_SIZE] = {1, 9, 7, 1, 0, 0, 0x10, 0, 4, 3, 2, 1,
						 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 1, 0, 0};
	uint8_t out[EF_BENCHMARK_SIZE];

	ef_report_benchmark(&status, out);
	TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, out, sizeof(out));
	status.state = EF_BENCHMARK_CLEANUP;
	ef_report_benchmark(&status, out);
	TEST_ASSERT_EQUAL_UINT8(0, out[28]);
	TEST_ASSERT_EQUAL_UINT8(0, out[29]);
}

void test_identity_layout(void)
{
	ef_identity_t identity = {
		.uid = {0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0, 0},
		.firmware = {0, 2, 1},
		.ram_total_bytes = 524288,
		.ram_reserved_bytes = 0x01020304,
	};
	uint8_t expected[EF_IDENTITY_SIZE] = {1, 0x03, 0x00, 0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0, 0, 0, 2, 1,
						    3, 1, 0, 0x97, 0x00, 0x00, 0x08, 0x00, 0x04, 0x03, 0x02, 0x01};
	uint8_t out[EF_IDENTITY_SIZE];

#if EF_ENABLE_STORAGE_BENCHMARK
	expected[17] = 0xB7;
#endif
	ef_report_identity(&identity, out);
	TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, out, sizeof(out));
}

void test_config_layout_reflects_saved_radios(void)
{
	ef_config_t config = {.stored_clock_mhz = 240, .stored_radios = 0x03,
			      .reset_cause = 3};
	const uint8_t expected[EF_CONFIG_SIZE] = {1, 240, 0, 0, 0, 43, 44, 12, 11, 13, 14, 15, 10, 0x1C, 3, 255, 255};
	uint8_t out[EF_CONFIG_SIZE];

	ef_report_config(&config, out);
	TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, out, sizeof(out));
	config.stored_radios = 0x02;
	ef_report_config(&config, out);
	TEST_ASSERT_EQUAL_HEX8(0x14, out[13]);
}

void test_telemetry_layout(void)
{
	ef_telemetry_t telemetry = {
		.temperature_valid = true,
		.temperature_centi_c = -125,
		.uptime_ms = 0x0000000100000002ull,
		.core0_load = 2500,
		.system_clock_hz = 240000000,
		.sequence = 9,
		.usb_configured = true,
	};
	uint8_t out[EF_TELEMETRY_SIZE];

	ef_report_telemetry(&telemetry, out);
	TEST_ASSERT_EQUAL_HEX8(0x83, out[2]);
	TEST_ASSERT_EQUAL_HEX8(0xFF, out[3]);
	TEST_ASSERT_EQUAL_HEX8(2, out[4]);
	TEST_ASSERT_EQUAL_HEX8(1, out[8]);
	TEST_ASSERT_EQUAL_HEX8(0xC4, out[12]);
	TEST_ASSERT_EQUAL_HEX8(0x09, out[13]);
	TEST_ASSERT_EQUAL_HEX8(0xFF, out[14]);
	TEST_ASSERT_EQUAL_HEX8(0xFF, out[15]);
	TEST_ASSERT_EQUAL_HEX8(0x00, out[16]);
	TEST_ASSERT_EQUAL_HEX8(0x0E, out[19]);
	TEST_ASSERT_EQUAL_UINT8(9, out[20]);
	TEST_ASSERT_EQUAL_HEX8(0x05, out[21]);
	telemetry.temperature_valid = false;
	telemetry.usb_configured = false;
	ef_report_telemetry(&telemetry, out);
	TEST_ASSERT_EQUAL_HEX8(0, out[2]);
	TEST_ASSERT_EQUAL_HEX8(0, out[3]);
	TEST_ASSERT_EQUAL_HEX8(0, out[21]);
	telemetry.led_available = true;
	telemetry.led_colour = 6;
	ef_report_telemetry(&telemetry, out);
	TEST_ASSERT_EQUAL_HEX8(6, out[1]);
	TEST_ASSERT_EQUAL_HEX8(8, out[21]);
	telemetry.led_available = false;
	ef_report_telemetry(&telemetry, out);
	TEST_ASSERT_EQUAL_HEX8(0, out[1]);
	TEST_ASSERT_EQUAL_HEX8(0, out[21]);
}

void test_storage_layout(void)
{
	ef_storage_t storage = {.sequence = 4, .configured = true, .sample_valid = true};
	uint8_t out[EF_STORAGE_SIZE];

	ef_report_storage(&storage, out);
	TEST_ASSERT_EQUAL_HEX8(0x41, out[2]);
	TEST_ASSERT_EQUAL_UINT8(0, out[3]);
	for (size_t i = 4; i < EF_STORAGE_SIZE; ++i) {
		TEST_ASSERT_EQUAL_UINT8(0, out[i]);
	}
	storage.initialized = true;
	storage.presence_known = true;
	storage.present = true;
	storage.capacity_valid = true;
	storage.bus_clock_hz = 25000000;
	storage.block_count = 0x00F00000;
	storage.filesystem_format = 3;
	ef_report_storage(&storage, out);
	TEST_ASSERT_EQUAL_UINT8(4, out[1]);
	TEST_ASSERT_EQUAL_HEX8(0x6F, out[2]);
	TEST_ASSERT_EQUAL_UINT8(1, out[3]);
	TEST_ASSERT_EQUAL_UINT8(3, out[4]);
	TEST_ASSERT_EQUAL_HEX8(0x40, out[5]);
	TEST_ASSERT_EQUAL_HEX8(0x78, out[6]);
	TEST_ASSERT_EQUAL_HEX8(0x7D, out[7]);
	TEST_ASSERT_EQUAL_HEX8(0x01, out[8]);
	TEST_ASSERT_EQUAL_UINT8(1, out[9]);
	TEST_ASSERT_EQUAL_HEX8(0xF0, out[12]);
	TEST_ASSERT_EQUAL_UINT8(3, out[30]);
	storage.capacity_valid = false;
	ef_report_storage(&storage, out);
	TEST_ASSERT_EQUAL_HEX8(0x4F, out[2]);
	TEST_ASSERT_EQUAL_UINT8(3, out[4]);
	for (size_t i = 10; i < 14; ++i) {
		TEST_ASSERT_EQUAL_UINT8(0, out[i]);
	}
}

void test_card_detect_allocation_and_msc_availability_are_reported(void)
{
	ef_config_t config = {.card_detect_available = true, .card_detect_gpio = 8, .msc_supported = true};
	uint8_t out[EF_CONFIG_SIZE];

	ef_report_config(&config, out);
	TEST_ASSERT_EQUAL_HEX8(0x45, out[13]);
	TEST_ASSERT_EQUAL_UINT8(8, out[16]);
}

void test_usb_owned_storage_report_never_exposes_stale_card_fields(void)
{
	ef_storage_t storage = {
		.configured = true, .sample_valid = true, .presence_known = true, .present = true,
		.initialized = true, .capacity_valid = true, .block_count = 100,
		.bus_clock_hz = 25000000, .msc_enabled = true,
	};
	uint8_t out[EF_STORAGE_SIZE];

	ef_report_storage(&storage, out);
	TEST_ASSERT_EQUAL_HEX8(1, out[2]);
	for (size_t i = 3; i < 30; ++i) {
		TEST_ASSERT_EQUAL_UINT8(0, out[i]);
	}
	TEST_ASSERT_EQUAL_UINT8(1, out[31]);
}

void test_wireless_layout_clears_reserved_flags(void)
{
	ef_wireless_t wireless = {
		.wifi_state = 3, .detail = 2, .ble_state = 2, .flags = 0xFF, .ipv4 = {192, 168, 1, 7},
		.ssid_length = 3, .ssid = {'l', 'a', 'b'}, .scan_state = 2, .scan_generation = 0x0102,
		.scan_count = 5, .test_generation = 6, .staged_state = 8,
	};
	uint8_t out[EF_WIRELESS_SIZE];

	ef_report_wireless(&wireless, out);
	TEST_ASSERT_EQUAL_HEX8(0xF3, out[4]);
	TEST_ASSERT_EQUAL_UINT8(192, out[5]);
	TEST_ASSERT_EQUAL_UINT8(3, out[9]);
	TEST_ASSERT_EQUAL_MEMORY("lab", out + 10, 3);
	TEST_ASSERT_EQUAL_UINT8(0, out[13]);
	TEST_ASSERT_EQUAL_UINT8(2, out[42]);
	TEST_ASSERT_EQUAL_HEX8(0x02, out[43]);
	TEST_ASSERT_EQUAL_HEX8(0x01, out[44]);
	TEST_ASSERT_EQUAL_UINT8(5, out[45]);
	TEST_ASSERT_EQUAL_UINT8(6, out[46]);
	TEST_ASSERT_EQUAL_UINT8(8, out[47]);
}

void test_helpers(void)
{
	const uint8_t uid[EF_UID_SIZE] = {0xA0, 0xB1, 0xC2, 0xD3, 0xE4, 0xF5, 0, 0};
	char hex[17];

	ef_uid_hex(uid, hex);
	TEST_ASSERT_EQUAL_STRING("A0B1C2D3E4F50000", hex);
	TEST_ASSERT_EQUAL_UINT8(1, ef_reset_cause(0x08 | 0x02));
	TEST_ASSERT_EQUAL_UINT8(2, ef_reset_cause(0x10));
	TEST_ASSERT_EQUAL_UINT8(3, ef_reset_cause(0x02));
	TEST_ASSERT_EQUAL_UINT8(0, ef_reset_cause(0x01));
	TEST_ASSERT_EQUAL_UINT16(EF_LOAD_UNAVAILABLE, ef_load_basis_points(1, 0));
	TEST_ASSERT_EQUAL_UINT16(2500, ef_load_basis_points(25, 100));
	TEST_ASSERT_EQUAL_UINT16(10000, ef_load_basis_points(200, 100));
}
