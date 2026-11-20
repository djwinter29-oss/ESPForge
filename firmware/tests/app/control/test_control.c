#include "unity.h"
#include "control.h"
#include "boot_config.h"
#include "boot_flash.h"
#include "hid_reports.h"
#include "wireless_stage.h"
#include "mock_zf_platform.h"

#include <errno.h>
#include <string.h>

static uint8_t flash[ZF_BOOT_CONFIG_RECORD_SIZE];
static int write_result;
static int write_calls;
static uint8_t txn;

int boot_flash_read(uint8_t *record, size_t size)
{
	memcpy(record, flash, size);
	return 0;
}

int boot_flash_write(const uint8_t *record, size_t size)
{
	++write_calls;
	if (write_result == 0) {
		memcpy(flash, record, size);
	}
	return write_result;
}

void setUp(void)
{
	memset(flash, 0xFF, sizeof(flash));
	write_result = 0;
	write_calls = 0;
	txn = 0;
	zf_boot_config_load();
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_ssid("home"));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password("saved-password"));
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	write_calls = 0;
	zf_control_init();
	zf_wifi_test_active_IgnoreAndReturn(false);
	zf_wifi_scan_active_IgnoreAndReturn(false);
	zf_platform_storage_busy_IgnoreAndReturn(false);
}

void tearDown(void)
{
}

/* Send a USB Feature 20 request and return the result. */
static const uint8_t *usb(uint8_t opcode, uint8_t flags, const uint8_t *args, size_t args_size, int64_t now)
{
	static uint8_t result[ZF_CONTROL_SIZE];
	uint8_t payload[ZF_CONTROL_SIZE] = {1, ++txn ? txn : ++txn, opcode, flags};

	if (args_size) {
		memcpy(payload + 4, args, args_size);
	}
	TEST_ASSERT_TRUE(zf_control_usb_set(payload, sizeof(payload), now));
	zf_control_usb_get(result);
	TEST_ASSERT_EQUAL_UINT8(1, result[0]);
	TEST_ASSERT_EQUAL_UINT8(payload[1], result[1]);
	TEST_ASSERT_EQUAL_UINT8(opcode, result[2]);
	return result;
}

static const uint8_t *ble(uint8_t opcode, uint8_t flags, const uint8_t *args, int64_t now)
{
	static uint8_t result[ZF_BLE_CONTROL_SIZE];
	uint8_t request[ZF_BLE_CONTROL_SIZE] = {1, ++txn ? txn : ++txn, opcode, flags};

	if (args) {
		memcpy(request + 4, args, 5);
	}
	TEST_ASSERT_TRUE(zf_control_ble_envelope(request, sizeof(request)));
	zf_control_ble_execute(request, now);
	zf_control_ble_get(result);
	TEST_ASSERT_EQUAL_UINT8(request[1], result[1]);
	return result;
}

static void assert_result(const uint8_t *result, uint8_t status, uint8_t error, uint8_t detail)
{
	TEST_ASSERT_EQUAL_UINT8_MESSAGE(status, result[3], "status");
	TEST_ASSERT_EQUAL_UINT8_MESSAGE(error, result[4], "error");
	TEST_ASSERT_EQUAL_UINT8_MESSAGE(detail, result[5], "detail");
}

static const uint8_t *stage(uint8_t opcode, const char *text, int64_t now)
{
	uint8_t args[64] = {(uint8_t)strlen(text)};

	memcpy(args + 1, text, args[0]);
	return usb(opcode, 0, args, sizeof(args), now);
}

void test_envelope_rejections(void)
{
	uint8_t payload[ZF_CONTROL_SIZE] = {1, 0, ZF_OP_REBOOT, 1};

	TEST_ASSERT_FALSE(zf_control_usb_set(payload, sizeof(payload), 0));
	payload[1] = 1;
	payload[0] = 2;
	TEST_ASSERT_FALSE(zf_control_usb_set(payload, sizeof(payload), 0));
	payload[0] = 1;
	TEST_ASSERT_FALSE(zf_control_usb_set(payload, sizeof(payload) - 1, 0));
	TEST_ASSERT_FALSE(zf_control_ble_envelope(payload, 8));
	TEST_ASSERT_FALSE(zf_control_ble_envelope((const uint8_t[9]){1, 0}, 9));
}

void test_initial_result_is_idle(void)
{
	uint8_t result[ZF_CONTROL_SIZE];

	zf_control_usb_get(result);
	TEST_ASSERT_EQUAL_UINT8(1, result[0]);
	TEST_ASSERT_EQUAL_UINT8(ZF_STATUS_IDLE, result[3]);
}

void test_unassigned_and_unsupported_opcodes(void)
{
	assert_result(usb(0, 0, NULL, 0, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_OPCODE, 0);
	assert_result(usb(14, 0, NULL, 0, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_OPCODE, 0);
#if !ZF_ENABLE_STORAGE_BENCHMARK
	assert_result(usb(ZF_OP_BENCHMARK, 0, NULL, 0, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
#endif
	assert_result(usb(ZF_OP_TCP_PROOF, 0, NULL, 0, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
}

void test_led_admission_and_invalid_arguments(void)
{
	const uint8_t blue = 4;
	const uint8_t invalid = 8;
	const uint8_t tail[] = {1, 1};

	zf_platform_led_request_ExpectAndReturn(blue, 0);
	assert_result(usb(ZF_OP_LED, 0, &blue, 1, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_platform_led_request_ExpectAndReturn(blue, -EBUSY);
	assert_result(usb(ZF_OP_LED, 0, &blue, 1, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 0);
	zf_platform_led_request_ExpectAndReturn(blue, -ENODEV);
	assert_result(usb(ZF_OP_LED, 0, &blue, 1, 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 0);
	assert_result(usb(ZF_OP_LED, 0, &invalid, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	assert_result(usb(ZF_OP_LED, 1, &blue, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(usb(ZF_OP_LED, 0, tail, sizeof(tail), 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
}

void test_benchmark_admission_size_and_transport_rules(void)
{
#if ZF_ENABLE_STORAGE_BENCHMARK
	const uint8_t start[5] = {1, 32, 0, 0, 0};
	const uint8_t invalid[5] = {1, 1, 4, 0, 0};

	zf_platform_benchmark_request_ExpectAndReturn(true, 32, 0);
	assert_result(usb(ZF_OP_BENCHMARK, 0, start, sizeof(start), 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_platform_benchmark_request_ExpectAndReturn(false, 0, 0);
	assert_result(usb(ZF_OP_BENCHMARK, 0, NULL, 0, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	assert_result(usb(ZF_OP_BENCHMARK, 0, invalid, sizeof(invalid), 0),
		      ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 3);
	assert_result(usb(ZF_OP_BENCHMARK, 1, start, sizeof(start), 0),
		      ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	zf_platform_benchmark_request_ExpectAndReturn(true, 32, 1);
	assert_result(usb(ZF_OP_BENCHMARK, 0, start, sizeof(start), 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 1);
	zf_platform_benchmark_request_ExpectAndReturn(true, 32, 2);
	assert_result(usb(ZF_OP_BENCHMARK, 0, start, sizeof(start), 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 2);
	zf_platform_benchmark_request_ExpectAndReturn(true, 32, 4);
	assert_result(usb(ZF_OP_BENCHMARK, 0, start, sizeof(start), 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 4);
#endif
	assert_result(ble(ZF_OP_BENCHMARK, 0, NULL, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
}

void test_msc_requires_confirmed_return_and_rejects_malformed_or_unsafe_actions(void)
{
	const uint8_t enable[1] = {1};
	const uint8_t invalid[1] = {2};

	assert_result(usb(ZF_OP_MSC, 0, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_CONFIRMATION, 0);
	assert_result(usb(ZF_OP_MSC, 1, enable, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(usb(ZF_OP_MSC, 1, invalid, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	zf_platform_storage_request_ExpectAnyArgsAndReturn(0);
	assert_result(usb(ZF_OP_MSC, 0, enable, 1, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_platform_storage_request_ExpectAnyArgsAndReturn(-EBUSY);
	assert_result(usb(ZF_OP_MSC, 1, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 0);
	zf_platform_storage_request_ExpectAnyArgsAndReturn(-ENOMEDIUM);
	assert_result(usb(ZF_OP_MSC, 0, enable, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	zf_platform_storage_request_ExpectAnyArgsAndReturn(-EIO);
	assert_result(usb(ZF_OP_MSC, 0, enable, 1, 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 0);
	assert_result(ble(ZF_OP_MSC, 0, enable, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
}

void test_reboot_and_save_do_not_run_while_storage_is_busy_or_usb_owned(void)
{
	const uint8_t settings[4] = {240, 0, 0, 3};

	zf_platform_storage_busy_StopIgnore();
	zf_platform_storage_busy_ExpectAndReturn(true);
	zf_platform_storage_busy_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_REBOOT, 1, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 1);
	assert_result(usb(ZF_OP_SAVE, 0, settings, sizeof(settings), 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, 1);
	TEST_ASSERT_EQUAL_INT(0, write_calls);
}

void test_reboot_requires_confirmation_and_clean_args(void)
{
	const uint8_t junk[1] = {1};

	assert_result(usb(ZF_OP_REBOOT, 0, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_CONFIRMATION, 0);
	assert_result(usb(ZF_OP_REBOOT, 3, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(usb(ZF_OP_REBOOT, 1, junk, 1, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	zf_platform_schedule_reboot_ExpectAndReturn(0);
	assert_result(usb(ZF_OP_REBOOT, 1, NULL, 0, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_platform_schedule_reboot_ExpectAndReturn(-EIO);
	assert_result(usb(ZF_OP_REBOOT, 1, NULL, 0, 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 0);
}

void test_save_settings_without_commit(void)
{
	const uint8_t args[4] = {160, 0, 0, ZF_WIRELESS_BLE};
	const uint8_t *result;

	zf_platform_schedule_reboot_ExpectAndReturn(0);
	result = usb(ZF_OP_SAVE, 0, args, sizeof(args), 0);
	assert_result(result, ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 160);
	TEST_ASSERT_EQUAL_UINT8(0, result[6]);
	TEST_ASSERT_EQUAL_UINT8(0, result[7]);
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_BLE, result[8]);
	TEST_ASSERT_EQUAL_UINT8(0, result[9]);
	TEST_ASSERT_EQUAL_INT(1, write_calls);
	zf_boot_config_load();
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_160MHZ, zf_boot_config_sysclk());
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_BLE, zf_boot_config_radios());
}

void test_save_rejects_bad_arguments_and_forced_flag(void)
{
	const uint8_t bad_clock[4] = {100, 0, 0, 3};
	const uint8_t sd_profile[4] = {0, 0, 1, 3};
	const uint8_t switch_bits[4] = {0, 0, 0, 7};
	uint8_t trailing[5] = {0, 0, 0, 3, 1};

	assert_result(usb(ZF_OP_SAVE, 1, NULL, 0, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
	assert_result(usb(ZF_OP_SAVE, 4, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(usb(ZF_OP_SAVE, 0, trailing, sizeof(trailing), 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(usb(ZF_OP_SAVE, 0, bad_clock, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	assert_result(usb(ZF_OP_SAVE, 0, sd_profile, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	assert_result(usb(ZF_OP_SAVE, 0, switch_bits, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	TEST_ASSERT_EQUAL_INT(0, write_calls);
}

void test_save_flash_failure_discards(void)
{
	const uint8_t args[4] = {80, 0, 0, 3};

	write_result = -EIO;
	assert_result(usb(ZF_OP_SAVE, 0, args, 4, 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 0);
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_DEFAULT, zf_boot_config_sysclk());
}

void test_staged_values_require_commit_flag(void)
{
	const uint8_t args[4] = {0, 0, 0, 3};

	assert_result(stage(ZF_OP_STAGE_PASSWORD, "password", 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	assert_result(usb(ZF_OP_SAVE, 0, args, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, ZF_DETAIL_COMMIT_FLAG);
}

void test_commit_new_network_and_key(void)
{
	const uint8_t args[4] = {0, 0, 0, 3};
	uint8_t key_args[64] = {32};
	uint8_t key[ZF_BLE_KEY_SIZE];
	char password[ZF_WIFI_PASSWORD_SIZE];
	char ssid[ZF_SSID_BUFFER_SIZE];
	const uint8_t *result;

	memset(key_args + 1, 0x5A, 32);
	stage(ZF_OP_STAGE_SSID, "lab", 0);
	assert_result(usb(ZF_OP_SAVE, 2, args, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, ZF_DETAIL_PAIR_INCOMPLETE);
	stage(ZF_OP_STAGE_PASSWORD, "lab-password", 0);
	assert_result(usb(ZF_OP_STAGE_KEY, 0, key_args, sizeof(key_args), 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_platform_schedule_reboot_ExpectAndReturn(0);
	result = usb(ZF_OP_SAVE, 2, args, 4, 0);
	assert_result(result, ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	TEST_ASSERT_EQUAL_HEX8(ZF_COMMIT_SSID | ZF_COMMIT_PASSWORD | ZF_COMMIT_KEY, result[9]);
	zf_boot_config_load();
	zf_boot_config_wifi_ssid(ssid);
	zf_boot_config_wifi_password(password);
	zf_boot_config_ble_key(key);
	TEST_ASSERT_EQUAL_STRING("lab", ssid);
	TEST_ASSERT_EQUAL_STRING("lab-password", password);
	TEST_ASSERT_EACH_EQUAL_HEX8(0x5A, key, sizeof(key));
}

void test_commit_without_staged_values_and_after_expiry(void)
{
	const uint8_t args[4] = {0, 0, 0, 3};
	uint8_t flags;
	uint8_t staged_state;

	assert_result(usb(ZF_OP_SAVE, 2, args, 4, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, ZF_DETAIL_NOTHING_STAGED);
	stage(ZF_OP_STAGE_PASSWORD, "password", 0);
	zf_wifi_test_cancel_Expect();
	zf_control_tick(ZF_STAGE_LIFETIME_MS);
	zf_control_stage_status(&flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGED_EXPIRED, staged_state);
	assert_result(usb(ZF_OP_SAVE, 2, args, 4, ZF_STAGE_LIFETIME_MS), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_EXPIRED);
}

void test_stage_validation(void)
{
	uint8_t args[64] = {33};
	uint8_t trailing[64] = {2, 'a', 'b', 'c'};

	assert_result(usb(ZF_OP_STAGE_SSID, 0, args, sizeof(args), 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_SSID_LENGTH);
	assert_result(usb(ZF_OP_STAGE_SSID, 0, trailing, sizeof(trailing), 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED,
		      0);
	assert_result(usb(ZF_OP_STAGE_SSID, 1, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(stage(ZF_OP_STAGE_PASSWORD, "short", 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_PASSWORD);
	args[0] = 16;
	assert_result(usb(ZF_OP_STAGE_KEY, 0, args, sizeof(args), 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_KEY_LENGTH);
}

void test_stage_busy_during_test(void)
{
	zf_wifi_test_active_StopIgnore();
	zf_wifi_test_active_ExpectAndReturn(true);
	assert_result(stage(ZF_OP_STAGE_SSID, "lab", 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_TEST_ACTIVE);
}

void test_wifi_test_starts_candidate_and_marks_tested(void)
{
	uint8_t flags;
	uint8_t staged_state;

	assert_result(usb(ZF_OP_TEST_WIFI, 0, NULL, 0, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_NOTHING_STAGED);
	stage(ZF_OP_STAGE_PASSWORD, "password", 0);
	zf_wifi_test_start_ExpectAndReturn((const uint8_t *)"home", 4, "password", 0);
	zf_wifi_test_start_IgnoreArg_ssid();
	assert_result(usb(ZF_OP_TEST_WIFI, 0, NULL, 0, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_control_test_joined(5);
	zf_control_stage_status(&flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGE_FLAG_PASSWORD | ZF_STAGE_FLAG_TESTED, flags);
	zf_wifi_test_start_ExpectAndReturn(NULL, 4, "password", -EIO);
	zf_wifi_test_start_IgnoreArg_ssid();
	assert_result(usb(ZF_OP_TEST_WIFI, 0, NULL, 0, 0), ZF_STATUS_FAILED, ZF_ERROR_FAILED, 0);
}

void test_wifi_test_and_scan_busy(void)
{
	zf_wifi_test_active_StopIgnore();
	zf_wifi_scan_active_StopIgnore();
	zf_wifi_test_active_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_TEST_WIFI, 0, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_TEST_ACTIVE);
	zf_wifi_test_active_ExpectAndReturn(false);
	zf_wifi_scan_active_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_TEST_WIFI, 0, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_SCAN_ACTIVE);
	zf_wifi_test_active_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_SCAN, 0, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_TEST_ACTIVE);
	zf_wifi_test_active_ExpectAndReturn(false);
	zf_wifi_scan_active_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_SCAN, 0, NULL, 0, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_SCAN_ACTIVE);
}

void test_commit_busy_while_test_active(void)
{
	const uint8_t args[4] = {0, 0, 0, 3};

	stage(ZF_OP_STAGE_PASSWORD, "password", 0);
	zf_wifi_test_active_StopIgnore();
	zf_wifi_test_active_ExpectAndReturn(true);
	assert_result(usb(ZF_OP_SAVE, 2, args, 4, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_TEST_ACTIVE);
}

void test_cancel_test_discards_stage(void)
{
	uint8_t flags;
	uint8_t staged_state;

	stage(ZF_OP_STAGE_PASSWORD, "password", 0);
	zf_wifi_test_cancel_Expect();
	assert_result(usb(ZF_OP_CANCEL_TEST, 0, NULL, 0, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_control_stage_status(&flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(0, flags);
	TEST_ASSERT_EQUAL_HEX8(0, staged_state);
}

void test_scan_start_and_entry(void)
{
	const uint8_t stale[3] = {0, 8, 0};
	const uint8_t out_of_range[3] = {2, 7, 0};
	const uint8_t entry[3] = {1, 7, 0};
	uint8_t ssid[ZF_SSID_MAX_BYTES] = {'c', 'a', 'f', 'e'};
	uint8_t length = 4;
	int8_t rssi = -61;
	uint8_t security = 3;
	const uint8_t *result;

	zf_wifi_scan_start_ExpectAndReturn(0);
	assert_result(usb(ZF_OP_SCAN, 0, NULL, 0, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	zf_wifi_scan_state_IgnoreAndReturn(ZF_SCAN_COMPLETE);
	zf_wifi_scan_generation_IgnoreAndReturn(7);
	zf_wifi_scan_count_IgnoreAndReturn(2);
	assert_result(usb(ZF_OP_SCAN_ENTRY, 0, stale, 3, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_SCAN_STALE);
	assert_result(usb(ZF_OP_SCAN_ENTRY, 0, out_of_range, 3, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT,
		      ZF_DETAIL_SCAN_INDEX);
	zf_wifi_scan_entry_ExpectAnyArgsAndReturn(0);
	zf_wifi_scan_entry_ReturnArrayThruPtr_ssid(ssid, 32);
	zf_wifi_scan_entry_ReturnThruPtr_ssid_length(&length);
	zf_wifi_scan_entry_ReturnThruPtr_rssi(&rssi);
	zf_wifi_scan_entry_ReturnThruPtr_security(&security);
	result = usb(ZF_OP_SCAN_ENTRY, 0, entry, 3, 0);
	assert_result(result, ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 7);
	TEST_ASSERT_EQUAL_UINT8(0, result[6]);
	TEST_ASSERT_EQUAL_UINT8(1, result[7]);
	TEST_ASSERT_EQUAL_UINT8(4, result[8]);
	TEST_ASSERT_EQUAL_MEMORY("cafe", result + 9, 4);
	TEST_ASSERT_EQUAL_UINT8((uint8_t)-61, result[41]);
	TEST_ASSERT_EQUAL_UINT8(3, result[42]);
}

void test_ble_rejects_usb_only_opcodes(void)
{
	assert_result(ble(ZF_OP_STAGE_SSID, 0, NULL, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
	assert_result(ble(ZF_OP_SCAN, 0, NULL, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_CAPABILITY, 0);
	zf_platform_led_request_ExpectAndReturn(0, 0);
	assert_result(ble(ZF_OP_LED, 0, NULL, 0), ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 0);
	assert_result(ble(14, 0, NULL, 0), ZF_STATUS_UNSUPPORTED, ZF_ERROR_OPCODE, 0);
}

void test_ble_save_requires_saved_radio_mask(void)
{
	const uint8_t changed[5] = {80, 0, 0, ZF_WIRELESS_WIFI, 0};
	const uint8_t same[5] = {80, 0, 0, ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE, 0};
	const uint8_t *result;

	assert_result(ble(ZF_OP_SAVE, 2, same, 0), ZF_STATUS_INVALID, ZF_ERROR_MALFORMED, 0);
	assert_result(ble(ZF_OP_SAVE, 0, changed, 0), ZF_STATUS_INVALID, ZF_ERROR_ARGUMENT, 0);
	zf_platform_schedule_reboot_ExpectAndReturn(0);
	result = ble(ZF_OP_SAVE, 0, same, 0);
	assert_result(result, ZF_STATUS_COMPLETED, ZF_ERROR_NONE, 80);
	TEST_ASSERT_EQUAL_UINT8(0, result[6]);
	TEST_ASSERT_EQUAL_UINT8(0, result[7]);
	TEST_ASSERT_EQUAL_UINT8(3, result[8]);
}

void test_ble_busy_while_usb_staged_and_slots_are_separate(void)
{
	uint8_t usb_result[ZF_CONTROL_SIZE];

	stage(ZF_OP_STAGE_PASSWORD, "password", 0);
	assert_result(ble(ZF_OP_REBOOT, 1, NULL, 0), ZF_STATUS_BUSY, ZF_ERROR_BUSY, ZF_DETAIL_USB_STAGED);
	zf_control_usb_get(usb_result);
	TEST_ASSERT_EQUAL_UINT8(ZF_OP_STAGE_PASSWORD, usb_result[2]);
	TEST_ASSERT_EQUAL_UINT8(ZF_STATUS_COMPLETED, usb_result[3]);
}
