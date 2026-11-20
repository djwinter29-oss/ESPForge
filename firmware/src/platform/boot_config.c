#include "platform/boot_config.h"
#include "platform/boot_flash.h"

#include <errno.h>
#include <string.h>

#define RECORD_MAGIC 0x46434645u /* "EFCF" little-endian */
#define RECORD_VERSION 1u
#define CRC_OFFSET 144u
#define SERVICE_BITS (ZF_WIRELESS_WIFI | ZF_WIRELESS_BLE)
#define KEY_PRESENT 1u

struct boot_config {
	uint8_t sysclk;
	uint8_t disabled;
	uint8_t auth;
	uint8_t ssid_length;
	uint8_t ssid[ZF_SSID_MAX_BYTES];
	char password[ZF_WIFI_PASSWORD_SIZE];
	uint8_t key[ZF_BLE_KEY_SIZE];
	uint8_t flags;
};

/* Zero is the default for every field: all radios allowed, build clock, no credentials. */
static struct boot_config staged;
static struct boot_config saved;
static struct boot_config boot;
static zf_boot_config_source_t source;

uint32_t zf_boot_config_crc32(const uint8_t *data, size_t size)
{
	uint32_t crc = 0xFFFFFFFFu;

	for (size_t i = 0; i < size; ++i) {
		crc ^= data[i];
		for (int bit = 0; bit < 8; ++bit) {
			crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
		}
	}
	return ~crc;
}

static void put_u16(uint8_t *out, uint16_t value)
{
	out[0] = (uint8_t)value;
	out[1] = (uint8_t)(value >> 8);
}

static void put_u32(uint8_t *out, uint32_t value)
{
	put_u16(out, (uint16_t)value);
	put_u16(out + 2, (uint16_t)(value >> 16));
}

static uint32_t get_u32(const uint8_t *in)
{
	return (uint32_t)in[0] | (uint32_t)in[1] << 8 | (uint32_t)in[2] << 16 | (uint32_t)in[3] << 24;
}

static bool zero(const uint8_t *data, size_t size)
{
	while (size--) {
		if (*data++) {
			return false;
		}
	}
	return true;
}

static bool password_valid(const char *password, size_t capacity)
{
	size_t length = 0;

	while (length < capacity && password[length]) {
		++length;
	}
	return length < capacity && (length == 0 || (length >= 8 && length <= 63));
}

static void encode(const struct boot_config *config, uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE])
{
	memset(record, 0, ZF_BOOT_CONFIG_RECORD_SIZE);
	put_u32(record, RECORD_MAGIC);
	put_u16(record + 4, RECORD_VERSION);
	put_u16(record + 6, ZF_BOOT_CONFIG_RECORD_SIZE);
	record[8] = config->sysclk;
	record[10] = config->disabled;
	record[11] = config->auth;
	record[12] = config->ssid_length;
	memcpy(record + 13, config->ssid, sizeof(config->ssid));
	memcpy(record + 45, config->password, sizeof(config->password));
	memcpy(record + 109, config->key, sizeof(config->key));
	record[141] = config->flags;
	put_u32(record + CRC_OFFSET, zf_boot_config_crc32(record, CRC_OFFSET));
}

static bool decode(const uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE], struct boot_config *config)
{
	const char *password = (const char *)record + 45;
	size_t password_length;

	if (get_u32(record) != RECORD_MAGIC || record[4] != RECORD_VERSION || record[5] != 0 ||
	    record[6] != ZF_BOOT_CONFIG_RECORD_SIZE || record[7] != 0 ||
	    get_u32(record + CRC_OFFSET) != zf_boot_config_crc32(record, CRC_OFFSET)) {
		return false;
	}
	if (record[8] > ZF_SYSCLK_240MHZ || record[9] != 0 || (record[10] & ~SERVICE_BITS) ||
	    record[11] > ZF_WIFI_AUTH_SAE || record[12] > ZF_SSID_MAX_BYTES ||
	    !zero(record + 13 + record[12], ZF_SSID_MAX_BYTES - record[12]) ||
	    !password_valid(password, ZF_WIFI_PASSWORD_SIZE) || (record[141] & ~KEY_PRESENT) ||
	    (!(record[141] & KEY_PRESENT) && !zero(record + 109, ZF_BLE_KEY_SIZE)) || record[142] || record[143]) {
		return false;
	}
	password_length = strlen(password);
	if (!zero(record + 45 + password_length, ZF_WIFI_PASSWORD_SIZE - password_length)) {
		return false;
	}
	memset(config, 0, sizeof(*config));
	config->sysclk = record[8];
	config->disabled = record[10];
	config->auth = record[11];
	config->ssid_length = record[12];
	memcpy(config->ssid, record + 13, sizeof(config->ssid));
	memcpy(config->password, password, sizeof(config->password));
	memcpy(config->key, record + 109, sizeof(config->key));
	config->flags = record[141];
	return true;
}

void zf_boot_config_load(void)
{
	uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE];
	struct boot_config loaded = {0};

	if (boot_flash_read(record, sizeof(record)) != 0) {
		source = ZF_BOOT_CONFIG_READ_ERROR;
	} else if (decode(record, &loaded)) {
		source = ZF_BOOT_CONFIG_SAVED;
	} else {
		memset(&loaded, 0, sizeof(loaded));
		source = ZF_BOOT_CONFIG_DEFAULTS;
	}
	saved = loaded;
	staged = loaded;
	boot = loaded;
	memset(record, 0, sizeof(record));
	memset(&loaded, 0, sizeof(loaded));
}

zf_boot_config_source_t zf_boot_config_source(void)
{
	return source;
}

zf_sysclk_profile_t zf_boot_config_sysclk(void)
{
	return (zf_sysclk_profile_t)staged.sysclk;
}

bool zf_boot_config_set_sysclk(zf_sysclk_profile_t profile)
{
	if ((unsigned)profile > ZF_SYSCLK_240MHZ) {
		return false;
	}
	staged.sysclk = (uint8_t)profile;
	return true;
}

zf_sysclk_profile_t zf_boot_config_boot_sysclk(void)
{
	return (zf_sysclk_profile_t)boot.sysclk;
}

uint8_t zf_boot_config_radios(void)
{
	return (uint8_t)(~staged.disabled & SERVICE_BITS);
}

bool zf_boot_config_set_radios(uint8_t radios)
{
	if (radios & ~SERVICE_BITS) {
		return false;
	}
	staged.disabled = (uint8_t)(~radios & SERVICE_BITS);
	return true;
}

uint8_t zf_boot_config_boot_radios(void)
{
	return (uint8_t)(~boot.disabled & SERVICE_BITS);
}

void zf_boot_config_wifi_ssid(char ssid[ZF_SSID_BUFFER_SIZE])
{
	memcpy(ssid, staged.ssid, sizeof(staged.ssid));
	ssid[ZF_SSID_BUFFER_SIZE - 1] = '\0';
}

bool zf_boot_config_set_wifi_ssid(const char *ssid)
{
	if (!ssid) {
		return false;
	}
	size_t length = 0;

	while (length < ZF_SSID_BUFFER_SIZE && ssid[length]) {
		++length;
	}
	return length < ZF_SSID_BUFFER_SIZE &&
	       zf_boot_config_set_wifi_ssid_bytes((const uint8_t *)ssid, (uint8_t)length);
}

uint8_t zf_boot_config_wifi_ssid_bytes(uint8_t ssid[ZF_SSID_MAX_BYTES])
{
	memcpy(ssid, staged.ssid, sizeof(staged.ssid));
	return staged.ssid_length;
}

bool zf_boot_config_set_wifi_ssid_bytes(const uint8_t *ssid, uint8_t length)
{
	if (length > sizeof(staged.ssid) || (!ssid && length)) {
		return false;
	}
	memset(staged.ssid, 0, sizeof(staged.ssid));
	if (length) {
		memcpy(staged.ssid, ssid, length);
	}
	staged.ssid_length = length;
	return true;
}

void zf_boot_config_wifi_password(char password[ZF_WIFI_PASSWORD_SIZE])
{
	memcpy(password, staged.password, sizeof(staged.password));
}

bool zf_boot_config_set_wifi_password(const char *password)
{
	if (!password || !password_valid(password, ZF_WIFI_PASSWORD_SIZE)) {
		return false;
	}
	memset(staged.password, 0, sizeof(staged.password));
	memcpy(staged.password, password, strlen(password));
	return true;
}

bool zf_boot_config_wifi_password_configured(void)
{
	return staged.password[0] != '\0';
}

zf_wifi_auth_state_t zf_boot_config_wifi_auth_state(void)
{
	return (zf_wifi_auth_state_t)staged.auth;
}

bool zf_boot_config_set_wifi_auth_state(zf_wifi_auth_state_t state)
{
	if ((unsigned)state > ZF_WIFI_AUTH_SAE) {
		return false;
	}
	staged.auth = (uint8_t)state;
	return true;
}

void zf_boot_config_ble_key(uint8_t key[ZF_BLE_KEY_SIZE])
{
	memcpy(key, staged.key, sizeof(staged.key));
}

void zf_boot_config_set_ble_key(const uint8_t key[ZF_BLE_KEY_SIZE])
{
	if (key) {
		memcpy(staged.key, key, sizeof(staged.key));
		staged.flags |= KEY_PRESENT;
	} else {
		memset(staged.key, 0, sizeof(staged.key));
		staged.flags &= (uint8_t)~KEY_PRESENT;
	}
}

bool zf_boot_config_ble_key_configured(void)
{
	return (staged.flags & KEY_PRESENT) != 0;
}

bool zf_boot_config_wireless_restart_required(void)
{
	return saved.disabled != boot.disabled || saved.auth != boot.auth ||
	       saved.ssid_length != boot.ssid_length || memcmp(saved.ssid, boot.ssid, sizeof(saved.ssid)) ||
	       memcmp(saved.password, boot.password, sizeof(saved.password)) || saved.flags != boot.flags ||
	       memcmp(saved.key, boot.key, sizeof(saved.key));
}

bool zf_boot_config_restart_required(void)
{
	return saved.sysclk != boot.sysclk || zf_boot_config_wireless_restart_required();
}

int zf_boot_config_save(void)
{
	uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE];
	int err;

	if (memcmp(&staged, &saved, sizeof(staged)) == 0) {
		return 0;
	}
	encode(&staged, record);
	err = boot_flash_write(record, sizeof(record));
	memset(record, 0, sizeof(record));
	if (err) {
		staged = saved;
		return err < 0 ? err : -EIO;
	}
	saved = staged;
	source = ZF_BOOT_CONFIG_SAVED;
	return 0;
}

void zf_boot_config_discard(void)
{
	staged = saved;
}

void zf_boot_config_encode(uint8_t record[ZF_BOOT_CONFIG_RECORD_SIZE])
{
	encode(&staged, record);
}
