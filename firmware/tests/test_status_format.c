#include "unity.h"
#include "status_format.h"
#include "mock_espforge.h"

#include <errno.h>
#include <limits.h>
#include <string.h>

void setUp(void)
{
}

void tearDown(void)
{
}

static void expect_status(int wifi_error, int ble_error, int connected, int sd_error)
{
	/* CMock retains these pointers until the production call executes. */
	static int radio_state[3];
	radio_state[0] = wifi_error;
	radio_state[1] = ble_error;
	radio_state[2] = connected;

	storage_error_ExpectAndReturn(sd_error);
	wireless_status_Expect(NULL, NULL, NULL);
	wireless_status_IgnoreArg_wifi_error();
	wireless_status_IgnoreArg_ble_error();
	wireless_status_IgnoreArg_connected();
	wireless_status_ReturnThruPtr_wifi_error(&radio_state[0]);
	wireless_status_ReturnThruPtr_ble_error(&radio_state[1]);
	wireless_status_ReturnThruPtr_connected(&radio_state[2]);
}

void test_status_matches_exact_wire_contract(void)
{
	char output[ESPFORGE_STATUS_SIZE];
	const char expected[] =
		"{\"protocol\":1,\"product\":\"ESPForge\",\"board\":\"ESP32-S3-DevKitC\","
		"\"firmware\":\"" ESPFORGE_VERSION "\",\"uptime_ms\":123000,"
		"\"wifi_enabled\":true,\"ble_enabled\":true,\"wifi_connected\":false,"
		"\"wifi_error\":0,\"ble_error\":0,\"sd_mounted\":false,\"sd_error\":-19}";

	expect_status(0, 0, 0, -19);
	TEST_ASSERT_EQUAL_INT(strlen(expected), status_format(output, sizeof(output), 123000));
	TEST_ASSERT_EQUAL_STRING(expected, output);
}

void test_status_reports_connected_radios_and_mocked_mount_state(void)
{
	char output[ESPFORGE_STATUS_SIZE];

	expect_status(0, 0, 1, 0);
	TEST_ASSERT_GREATER_THAN_INT(0, status_format(output, sizeof(output), 0));
	TEST_ASSERT_NOT_NULL(strstr(output, "\"wifi_connected\":true"));
	TEST_ASSERT_NOT_NULL(strstr(output, "\"sd_mounted\":true,\"sd_error\":0"));
}

void test_status_preserves_radio_and_storage_errors(void)
{
	char output[ESPFORGE_STATUS_SIZE];

	expect_status(-115, -5, 0, -11);
	TEST_ASSERT_GREATER_THAN_INT(0, status_format(output, sizeof(output), 1));
	TEST_ASSERT_NOT_NULL(strstr(output,
		"\"wifi_error\":-115,\"ble_error\":-5,\"sd_mounted\":false,\"sd_error\":-11"));
	TEST_ASSERT_NOT_NULL(strstr(output, "\"wifi_enabled\":true,\"ble_enabled\":true"));
}

void test_status_fits_protocol_buffer_at_numeric_limits(void)
{
	char output[ESPFORGE_STATUS_SIZE];

	expect_status(INT_MIN, INT_MIN, 1, INT_MIN);
	int length = status_format(output, sizeof(output), INT64_MAX);

	TEST_ASSERT_GREATER_THAN_INT(0, length);
	TEST_ASSERT_LESS_THAN_INT(ESPFORGE_STATUS_SIZE, length);
	TEST_ASSERT_EQUAL_UINT(strlen(output), length);
	TEST_ASSERT_NOT_NULL(strstr(output, "\"uptime_ms\":9223372036854775807"));
}

void test_status_requires_space_for_null_terminator(void)
{
	char output[ESPFORGE_STATUS_SIZE];

	expect_status(0, 0, 0, -19);
	int length = status_format(output, sizeof(output), 0);
	TEST_ASSERT_GREATER_THAN_INT(0, length);

	expect_status(0, 0, 0, -19);
	TEST_ASSERT_EQUAL_INT(-ENOSPC, status_format(output, (size_t)length, 0));
	TEST_ASSERT_EQUAL_CHAR('\0', output[length - 1]);

	expect_status(0, 0, 0, -19);
	TEST_ASSERT_EQUAL_INT(length, status_format(output, (size_t)length + 1, 0));
}

void test_status_small_buffer_returns_error_without_overwrite(void)
{
	char output[2] = {'x', 'x'};

	expect_status(0, 0, 0, -19);
	TEST_ASSERT_EQUAL_INT(-ENOSPC, status_format(output, 1, 0));
	TEST_ASSERT_EQUAL_CHAR('\0', output[0]);
	TEST_ASSERT_EQUAL_CHAR('x', output[1]);
}

void test_status_zero_capacity_returns_error(void)
{
	expect_status(0, 0, 0, -19);
	TEST_ASSERT_EQUAL_INT(-ENOSPC, status_format(NULL, 0, 0));
}

void test_status_null_buffer_with_capacity_returns_error(void)
{
	TEST_ASSERT_EQUAL_INT(-EINVAL, status_format(NULL, 1, 0));
}
