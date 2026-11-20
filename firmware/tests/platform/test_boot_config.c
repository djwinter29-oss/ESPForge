#include "unity.h"
#include "boot_config.h"
#include "boot_flash.h"

#include <errno.h>
#include <string.h>

static uint8_t flash[ZF_BOOT_CONFIG_RECORD_SIZE];
static int read_result;
static int write_result;
static int write_calls;

int boot_flash_read(uint8_t *record, size_t size)
{
	TEST_ASSERT_EQUAL_UINT(sizeof(flash), size);
	memcpy(record, flash, size);
	return read_result;
}

int boot_flash_write(const uint8_t *record, size_t size)
{
	TEST_ASSERT_EQUAL_UINT(sizeof(flash), size);
	++write_calls;
	if (write_result == 0) {
		memcpy(flash, record, size);
	}
	return write_result;
}

static void erase_flash(void)
{
	memset(flash, 0xFF, sizeof(flash));
}

static void reseal(void)
{
	uint32_t crc = zf_boot_config_crc32(flash, 144);

	flash[144] = (uint8_t)crc;
	flash[145] = (uint8_t)(crc >> 8);
	flash[146] = (uint8_t)(crc >> 16);
	flash[147] = (uint8_t)(crc >> 24);
}

static void save_valid_record(void)
{
	erase_flash();
	zf_boot_config_load();
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_ssid("lab"));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password("password"));
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
}

static void assert_defaults(void)
{
	char ssid[ZF_SSID_BUFFER_SIZE];

	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE, zf_boot_config_radios());
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_DEFAULT, zf_boot_config_sysclk());
	TEST_ASSERT_EQUAL_INT(ZF_WIFI_AUTH_TRY_WPA2, zf_boot_config_wifi_auth_state());
	TEST_ASSERT_FALSE(zf_boot_config_wifi_password_configured());
	TEST_ASSERT_FALSE(zf_boot_config_ble_key_configured());
	zf_boot_config_wifi_ssid(ssid);
	TEST_ASSERT_EQUAL_STRING("", ssid);
}

void setUp(void)
{
	read_result = 0;
	write_result = 0;
	write_calls = 0;
	erase_flash();
	zf_boot_config_load();
	write_calls = 0;
}

void tearDown(void)
{
}

void test_crc_matches_ieee_check_value(void)
{
	TEST_ASSERT_EQUAL_HEX32(0xCBF43926u, zf_boot_config_crc32((const uint8_t *)"123456789", 9));
}

void test_sysclk_profiles_convert_to_and_from_mhz(void)
{
	TEST_ASSERT_EQUAL_UINT16(0, zf_sysclk_profile_mhz(ZF_SYSCLK_DEFAULT));
	TEST_ASSERT_EQUAL_UINT16(80, zf_sysclk_profile_mhz(ZF_SYSCLK_80MHZ));
	TEST_ASSERT_EQUAL_UINT16(160, zf_sysclk_profile_mhz(ZF_SYSCLK_160MHZ));
	TEST_ASSERT_EQUAL_UINT16(240, zf_sysclk_profile_mhz(ZF_SYSCLK_240MHZ));
	TEST_ASSERT_EQUAL_UINT16(0, zf_sysclk_profile_mhz((zf_sysclk_profile_t)4));
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_160MHZ, zf_sysclk_profile_from_mhz(160));
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_DEFAULT, zf_sysclk_profile_from_mhz(0));
	TEST_ASSERT_FALSE(zf_boot_config_set_sysclk(zf_sysclk_profile_from_mhz(200)));
}

void test_erased_flash_loads_defaults_with_both_radios(void)
{
	TEST_ASSERT_EQUAL_INT(ZF_BOOT_CONFIG_DEFAULTS, zf_boot_config_source());
	assert_defaults();
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE, zf_boot_config_boot_radios());
	TEST_ASSERT_FALSE(zf_boot_config_restart_required());
}

void test_read_error_loads_defaults(void)
{
	save_valid_record();
	read_result = -EIO;
	zf_boot_config_load();
	TEST_ASSERT_EQUAL_INT(ZF_BOOT_CONFIG_READ_ERROR, zf_boot_config_source());
	assert_defaults();
}

void test_record_layout_matches_documented_offsets(void)
{
	uint8_t key[ZF_BLE_KEY_SIZE];

	memset(key, 0xA5, sizeof(key));
	TEST_ASSERT_TRUE(zf_boot_config_set_sysclk(ZF_SYSCLK_160MHZ));
	TEST_ASSERT_TRUE(zf_boot_config_set_radios(ZF_WIRELESS_BLE));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_auth_state(ZF_WIFI_AUTH_SAE));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_ssid("lab"));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password("password"));
	zf_boot_config_set_ble_key(key);
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	TEST_ASSERT_EQUAL_INT(1, write_calls);

	TEST_ASSERT_EQUAL_MEMORY("EFCF", flash, 4);
	TEST_ASSERT_EQUAL_UINT8(1, flash[4]);
	TEST_ASSERT_EQUAL_UINT8(0, flash[5]);
	TEST_ASSERT_EQUAL_UINT8(148, flash[6]);
	TEST_ASSERT_EQUAL_UINT8(0, flash[7]);
	TEST_ASSERT_EQUAL_UINT8(ZF_SYSCLK_160MHZ, flash[8]);
	TEST_ASSERT_EQUAL_UINT8(0, flash[9]);
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI, flash[10]);
	TEST_ASSERT_EQUAL_UINT8(ZF_WIFI_AUTH_SAE, flash[11]);
	TEST_ASSERT_EQUAL_UINT8(3, flash[12]);
	TEST_ASSERT_EQUAL_MEMORY("lab", flash + 13, 3);
	TEST_ASSERT_EQUAL_STRING("password", (const char *)flash + 45);
	TEST_ASSERT_EQUAL_MEMORY(key, flash + 109, sizeof(key));
	TEST_ASSERT_EQUAL_UINT8(1, flash[141]);
	TEST_ASSERT_EQUAL_UINT8(0, flash[142]);
	TEST_ASSERT_EQUAL_UINT8(0, flash[143]);
	uint32_t crc = zf_boot_config_crc32(flash, 144);
	TEST_ASSERT_EQUAL_HEX32(crc, flash[144] | flash[145] << 8 | flash[146] << 16 | (uint32_t)flash[147] << 24);
}

void test_saved_record_round_trips_and_applies_at_next_boot(void)
{
	uint8_t ssid[ZF_SSID_MAX_BYTES];
	const uint8_t opaque[] = {'a', 0, 'b'};
	char password[ZF_WIFI_PASSWORD_SIZE];

	TEST_ASSERT_TRUE(zf_boot_config_set_sysclk(ZF_SYSCLK_80MHZ));
	TEST_ASSERT_TRUE(zf_boot_config_set_radios(ZF_WIRELESS_WIFI));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_ssid_bytes(opaque, sizeof(opaque)));
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password("12345678"));
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());

	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE, zf_boot_config_boot_radios());
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_DEFAULT, zf_boot_config_boot_sysclk());
	TEST_ASSERT_TRUE(zf_boot_config_restart_required());
	TEST_ASSERT_TRUE(zf_boot_config_wireless_restart_required());

	zf_boot_config_load();
	TEST_ASSERT_EQUAL_INT(ZF_BOOT_CONFIG_SAVED, zf_boot_config_source());
	TEST_ASSERT_FALSE(zf_boot_config_restart_required());
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI, zf_boot_config_boot_radios());
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_80MHZ, zf_boot_config_boot_sysclk());
	TEST_ASSERT_EQUAL_UINT8(3, zf_boot_config_wifi_ssid_bytes(ssid));
	TEST_ASSERT_EQUAL_MEMORY(opaque, ssid, sizeof(opaque));
	zf_boot_config_wifi_password(password);
	TEST_ASSERT_EQUAL_STRING("12345678", password);
}

void test_clock_only_change_does_not_require_wireless_restart(void)
{
	TEST_ASSERT_TRUE(zf_boot_config_set_sysclk(ZF_SYSCLK_240MHZ));
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	TEST_ASSERT_TRUE(zf_boot_config_restart_required());
	TEST_ASSERT_FALSE(zf_boot_config_wireless_restart_required());
}

void test_unchanged_save_does_not_write_flash(void)
{
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	TEST_ASSERT_EQUAL_INT(0, write_calls);
}

void test_failed_save_discards_staged_values(void)
{
	write_result = -EIO;
	TEST_ASSERT_TRUE(zf_boot_config_set_radios(0));
	TEST_ASSERT_EQUAL_INT(-EIO, zf_boot_config_save());
	TEST_ASSERT_EQUAL_UINT8(ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE, zf_boot_config_radios());
	TEST_ASSERT_FALSE(zf_boot_config_restart_required());
}

void test_discard_restores_last_saved_values(void)
{
	save_valid_record();
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_ssid(""));
	TEST_ASSERT_TRUE(zf_boot_config_set_sysclk(ZF_SYSCLK_80MHZ));
	zf_boot_config_discard();
	char ssid[ZF_SSID_BUFFER_SIZE];
	zf_boot_config_wifi_ssid(ssid);
	TEST_ASSERT_EQUAL_STRING("lab", ssid);
	TEST_ASSERT_EQUAL_INT(ZF_SYSCLK_DEFAULT, zf_boot_config_sysclk());
}

void test_setters_reject_invalid_values_without_change(void)
{
	char long_ssid[34];
	char long_password[65];

	memset(long_ssid, 'a', 33);
	long_ssid[33] = '\0';
	memset(long_password, 'p', 64);
	long_password[64] = '\0';
	TEST_ASSERT_FALSE(zf_boot_config_set_sysclk((zf_sysclk_profile_t)4));
	TEST_ASSERT_FALSE(zf_boot_config_set_radios(4));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_ssid(long_ssid));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_ssid(NULL));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_ssid_bytes(NULL, 1));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_ssid_bytes((const uint8_t *)long_ssid, 33));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_password("short"));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_password(long_password));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_password(NULL));
	TEST_ASSERT_FALSE(zf_boot_config_set_wifi_auth_state((zf_wifi_auth_state_t)4));
	assert_defaults();
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	TEST_ASSERT_EQUAL_INT(0, write_calls);
}

void test_password_accepts_boundary_lengths_and_empty(void)
{
	char password[64];

	memset(password, '~', 63);
	password[63] = '\0';
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password(password));
	TEST_ASSERT_TRUE(zf_boot_config_wifi_password_configured());
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password(""));
	TEST_ASSERT_FALSE(zf_boot_config_wifi_password_configured());
	/* The hosts send any non-NUL UTF-8 bytes; the record keeps that contract. */
	TEST_ASSERT_TRUE(zf_boot_config_set_wifi_password("p\xC3\xA4sswort"));
	TEST_ASSERT_TRUE(zf_boot_config_wifi_password_configured());
}

void test_all_zero_key_is_present_until_cleared(void)
{
	uint8_t key[ZF_BLE_KEY_SIZE] = {0};
	uint8_t copy[ZF_BLE_KEY_SIZE];

	zf_boot_config_set_ble_key(key);
	TEST_ASSERT_TRUE(zf_boot_config_ble_key_configured());
	TEST_ASSERT_EQUAL_INT(0, zf_boot_config_save());
	zf_boot_config_load();
	TEST_ASSERT_TRUE(zf_boot_config_ble_key_configured());
	zf_boot_config_ble_key(copy);
	TEST_ASSERT_EQUAL_MEMORY(key, copy, sizeof(key));
	zf_boot_config_set_ble_key(NULL);
	TEST_ASSERT_FALSE(zf_boot_config_ble_key_configured());
}

void test_corrupted_crc_loads_defaults(void)
{
	save_valid_record();
	flash[144] ^= 1u;
	zf_boot_config_load();
	TEST_ASSERT_EQUAL_INT(ZF_BOOT_CONFIG_DEFAULTS, zf_boot_config_source());
	assert_defaults();
}

void test_invalid_fields_with_valid_crc_load_defaults(void)
{
	static const struct {
		uint8_t offset;
		uint8_t value;
	} cases[] = {
		{0, 'P'},    /* magic */
		{4, 2},      /* version */
		{6, 147},    /* size */
		{8, 4},      /* clock profile */
		{9, 1},      /* reserved SD speed byte */
		{10, 4},     /* unknown service bit */
		{11, 4},     /* auth state */
		{12, 33},    /* SSID length */
		{20, 'x'},   /* SSID byte beyond length */
		{48, '\0'},  /* passphrase shorter than eight characters */
		{60, 'x'},   /* byte after the passphrase terminator */
		{110, 1},    /* key bytes without the present flag */
		{141, 2},    /* unknown credential flag */
		{142, 1},    /* reserved */
	};

	for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
		save_valid_record();
		flash[cases[i].offset] = cases[i].value;
		reseal();
		zf_boot_config_load();
		TEST_ASSERT_EQUAL_INT_MESSAGE(ZF_BOOT_CONFIG_DEFAULTS, zf_boot_config_source(), "invalid field accepted");
		assert_defaults();
	}
}
