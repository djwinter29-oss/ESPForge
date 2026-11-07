#include "control.h"
#include "boot_config.h"
#include "ef_platform.h"
#include "wireless_stage.h"

#include <string.h>

#define FLAG_CONFIRM 0x01u
#define FLAG_FORCED_SAVE 0x01u
#define FLAG_COMMIT 0x02u
#define ARGS_SIZE 64u

typedef struct {
	uint8_t transaction_id;
	uint8_t opcode;
	uint8_t status;
	uint8_t error;
	uint8_t data[63];
} result_t;

typedef struct {
	bool ble;
	uint8_t transaction_id;
	uint8_t opcode;
	uint8_t flags;
	uint8_t args[ARGS_SIZE];
} request_t;

static result_t usb_result;
static result_t ble_result;
static ef_stage_t stage;

void ef_control_init(void)
{
	memset(&usb_result, 0, sizeof(usb_result));
	memset(&ble_result, 0, sizeof(ble_result));
	ef_stage_reset(&stage);
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

static void finish(result_t *result, uint8_t status, uint8_t error, uint8_t detail)
{
	result->status = status;
	result->error = error;
	result->data[0] = detail;
}

static void put_saved_network(ef_saved_network_t *saved, uint8_t ssid[32], char password[EF_WIFI_PASSWORD_SIZE])
{
	saved->ssid_length = ef_boot_config_wifi_ssid_bytes(ssid);
	ef_boot_config_wifi_password(password);
	saved->ssid = ssid;
	saved->password = password;
}

static void reboot(const request_t *request, result_t *result)
{
	if ((request->flags & ~FLAG_CONFIRM) || !zero(request->args, ARGS_SIZE)) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
	} else if (!(request->flags & FLAG_CONFIRM)) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_CONFIRMATION, 0);
	} else if (request->ble && ef_stage_active(&stage)) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_USB_STAGED);
	} else if (ef_platform_schedule_reboot() != 0) {
		finish(result, EF_STATUS_FAILED, EF_ERROR_FAILED, 0);
	} else {
		ef_stage_reset(&stage);
		finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
	}
}

static void apply_commit(void)
{
	if (stage.ssid_staged) {
		(void)ef_boot_config_set_wifi_ssid_bytes(stage.ssid, stage.ssid_length);
	}
	if (stage.password_staged) {
		(void)ef_boot_config_set_wifi_password(stage.password);
	}
	if (stage.ssid_staged || stage.password_staged) {
		(void)ef_boot_config_set_wifi_auth_state(EF_WIFI_AUTH_TRY_WPA2);
	}
	if (stage.key_staged) {
		ef_boot_config_set_ble_key(stage.key_clear ? NULL : stage.key);
	}
}

static void save(const request_t *request, result_t *result)
{
	uint16_t mhz = (uint16_t)(request->args[0] | request->args[1] << 8);
	uint8_t radios = request->args[3];
	bool commit = (request->flags & FLAG_COMMIT) != 0;
	ef_sysclk_profile_t profile = ef_sysclk_profile_from_mhz(mhz);
	uint8_t commit_mask = 0;
	uint8_t detail;
	int err;

	if (!request->ble && (request->flags & FLAG_FORCED_SAVE)) {
		finish(result, EF_STATUS_UNSUPPORTED, EF_ERROR_CAPABILITY, 0);
		return;
	}
	if ((request->flags & ~(request->ble ? 0u : FLAG_COMMIT)) || !zero(request->args + 4, ARGS_SIZE - 4)) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		return;
	}
	if (profile > EF_SYSCLK_240MHZ || request->args[2] != 0 ||
	    (radios & (uint8_t)~(EF_WIRELESS_WIFI | EF_WIRELESS_BLE))) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, 0);
		return;
	}
	if (request->ble && ef_stage_active(&stage)) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_USB_STAGED);
		return;
	}
	if (commit && ef_wifi_test_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_TEST_ACTIVE);
		return;
	}
	if (commit && ef_wifi_scan_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_SCAN_ACTIVE);
		return;
	}
	if (request->ble && radios != ef_boot_config_radios()) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, 0);
		return;
	}
	if (commit) {
		uint8_t ssid[32];
		char password[EF_WIFI_PASSWORD_SIZE];
		ef_saved_network_t saved;

		put_saved_network(&saved, ssid, password);
		detail = ef_stage_check_commit(&stage, &saved);
		memset(password, 0, sizeof(password));
		if (detail) {
			finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, detail);
			return;
		}
		commit_mask = ef_stage_commit_mask(&stage);
	} else if (ef_stage_active(&stage)) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, EF_DETAIL_COMMIT_FLAG);
		return;
	}

	(void)ef_boot_config_set_sysclk(profile);
	(void)ef_boot_config_set_radios(radios);
	if (commit) {
		apply_commit();
	}
	err = ef_boot_config_save();
	if (err) {
		ef_boot_config_discard();
		finish(result, EF_STATUS_FAILED, EF_ERROR_FAILED, 0);
		return;
	}
	ef_stage_reset(&stage);
	if (ef_platform_schedule_reboot() != 0) {
		finish(result, EF_STATUS_FAILED, EF_ERROR_FAILED, 0);
		return;
	}
	finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
	mhz = ef_sysclk_profile_mhz(ef_boot_config_sysclk());
	result->data[0] = (uint8_t)mhz;
	result->data[1] = (uint8_t)(mhz >> 8);
	result->data[2] = 0;
	result->data[3] = ef_boot_config_radios();
	result->data[4] = request->ble ? 0 : commit_mask;
}

static void stage_value(const request_t *request, result_t *result, int64_t now_ms)
{
	static uint8_t (*const check[])(const uint8_t *) = {
		ef_stage_check_ssid, ef_stage_check_password, ef_stage_check_key,
	};
	static const uint8_t capacity[] = {EF_STAGE_SSID_MAX, EF_STAGE_PASSWORD_MAX, EF_STAGE_KEY_SIZE};
	unsigned index = request->opcode - EF_OP_STAGE_SSID;
	uint8_t detail;

	if (request->flags) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		return;
	}
	detail = check[index](request->args);
	if (detail) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, detail);
		return;
	}
	if (!zero(request->args + 1 + request->args[0], ARGS_SIZE - 1u - request->args[0]) ||
	    request->args[0] > capacity[index]) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		return;
	}
	if (ef_wifi_test_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_TEST_ACTIVE);
		return;
	}
	if (request->opcode == EF_OP_STAGE_SSID) {
		ef_stage_ssid(&stage, request->args, now_ms);
	} else if (request->opcode == EF_OP_STAGE_PASSWORD) {
		ef_stage_password(&stage, request->args, now_ms);
	} else {
		ef_stage_key(&stage, request->args, now_ms);
	}
	finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
}

static void test_wifi(result_t *result)
{
	uint8_t ssid[32];
	char password[EF_WIFI_PASSWORD_SIZE];
	ef_saved_network_t saved;
	ef_candidate_t candidate;
	uint8_t detail;

	if (ef_wifi_test_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_TEST_ACTIVE);
		return;
	}
	if (ef_wifi_scan_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_SCAN_ACTIVE);
		return;
	}
	put_saved_network(&saved, ssid, password);
	detail = ef_stage_test_candidate(&stage, &saved, &candidate);
	if (detail) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, detail);
	} else if (ef_wifi_test_start(candidate.ssid, candidate.ssid_length, candidate.password) != 0) {
		finish(result, EF_STATUS_FAILED, EF_ERROR_FAILED, 0);
	} else {
		stage.pair_tested = false;
		finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
	}
	memset(password, 0, sizeof(password));
}

static void scan_entry(const request_t *request, result_t *result)
{
	uint16_t generation = (uint16_t)(request->args[1] | request->args[2] << 8);
	uint8_t ssid[32] = {0};
	uint8_t length = 0;
	int8_t rssi = 0;
	uint8_t security = 0;

	if (ef_wifi_scan_active()) {
		finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_SCAN_ACTIVE);
		return;
	}
	if (ef_wifi_scan_state() != EF_SCAN_COMPLETE || generation != ef_wifi_scan_generation()) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, EF_DETAIL_SCAN_STALE);
		return;
	}
	if (request->args[0] >= ef_wifi_scan_count() ||
	    ef_wifi_scan_entry(request->args[0], ssid, &length, &rssi, &security) != 0) {
		finish(result, EF_STATUS_INVALID, EF_ERROR_ARGUMENT, EF_DETAIL_SCAN_INDEX);
		return;
	}
	finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
	result->data[0] = (uint8_t)generation;
	result->data[1] = (uint8_t)(generation >> 8);
	result->data[2] = request->args[0];
	result->data[3] = length <= 32 ? length : 32;
	memcpy(result->data + 4, ssid, result->data[3]);
	result->data[36] = (uint8_t)rssi;
	result->data[37] = security & 0x07u;
}

static bool args_clear(const request_t *request, size_t from)
{
	return request->flags == 0 && zero(request->args + from, ARGS_SIZE - from);
}

static void execute(const request_t *request, result_t *result, int64_t now_ms)
{
	memset(result, 0, sizeof(*result));
	result->transaction_id = request->transaction_id;
	result->opcode = request->opcode;

	if (request->opcode == 0 || request->opcode > EF_OP_TCP_PROOF) {
		finish(result, EF_STATUS_UNSUPPORTED, EF_ERROR_OPCODE, 0);
		return;
	}
	if (request->ble && request->opcode != EF_OP_LED && request->opcode != EF_OP_REBOOT &&
	    request->opcode != EF_OP_SAVE) {
		finish(result, EF_STATUS_UNSUPPORTED, EF_ERROR_CAPABILITY, 0);
		return;
	}
	switch (request->opcode) {
	case EF_OP_REBOOT:
		reboot(request, result);
		break;
	case EF_OP_SAVE:
		save(request, result);
		break;
	case EF_OP_STAGE_SSID:
	case EF_OP_STAGE_PASSWORD:
	case EF_OP_STAGE_KEY:
		stage_value(request, result, now_ms);
		break;
	case EF_OP_TEST_WIFI:
		if (!args_clear(request, 0)) {
			finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		} else {
			test_wifi(result);
		}
		break;
	case EF_OP_CANCEL_TEST:
		if (!args_clear(request, 0)) {
			finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
			break;
		}
		ef_stage_reset(&stage);
		ef_wifi_test_cancel();
		finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
		break;
	case EF_OP_SCAN:
		if (!args_clear(request, 0)) {
			finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		} else if (ef_wifi_test_active()) {
			finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_TEST_ACTIVE);
		} else if (ef_wifi_scan_active()) {
			finish(result, EF_STATUS_BUSY, EF_ERROR_BUSY, EF_DETAIL_SCAN_ACTIVE);
		} else if (ef_wifi_scan_start() != 0) {
			finish(result, EF_STATUS_FAILED, EF_ERROR_FAILED, 0);
		} else {
			finish(result, EF_STATUS_COMPLETED, EF_ERROR_NONE, 0);
		}
		break;
	case EF_OP_SCAN_ENTRY:
		if (!args_clear(request, 3)) {
			finish(result, EF_STATUS_INVALID, EF_ERROR_MALFORMED, 0);
		} else {
			scan_entry(request, result);
		}
		break;
	default:
		/* LED, MSC, benchmark and TCP CLI proof are absent; see docs/reference/espforge-profile.md. */
		finish(result, EF_STATUS_UNSUPPORTED, EF_ERROR_CAPABILITY, 0);
		break;
	}
}

bool ef_control_usb_set(const uint8_t *payload, size_t size, int64_t now_ms)
{
	request_t request = {0};

	if (size != EF_CONTROL_SIZE || payload[0] != 1 || payload[1] == 0) {
		return false;
	}
	ef_control_tick(now_ms);
	request.transaction_id = payload[1];
	request.opcode = payload[2];
	request.flags = payload[3];
	memcpy(request.args, payload + 4, ARGS_SIZE);
	execute(&request, &usb_result, now_ms);
	memset(&request, 0, sizeof(request));
	return true;
}

static void encode(const result_t *result, uint8_t *out, size_t data_size)
{
	out[0] = 1;
	out[1] = result->transaction_id;
	out[2] = result->opcode;
	out[3] = result->status;
	out[4] = result->error;
	memcpy(out + 5, result->data, data_size);
}

void ef_control_usb_get(uint8_t out[EF_CONTROL_SIZE])
{
	encode(&usb_result, out, sizeof(usb_result.data));
}

bool ef_control_ble_envelope(const uint8_t *request, size_t size)
{
	return size == EF_BLE_CONTROL_SIZE && request[0] == 1 && request[1] != 0;
}

void ef_control_ble_execute(const uint8_t request[EF_BLE_CONTROL_SIZE], int64_t now_ms)
{
	request_t normalized = {.ble = true};

	ef_control_tick(now_ms);
	normalized.transaction_id = request[1];
	normalized.opcode = request[2];
	normalized.flags = request[3];
	memcpy(normalized.args, request + 4, EF_BLE_CONTROL_SIZE - 4);
	execute(&normalized, &ble_result, now_ms);
	/* The BLE result carries only four data bytes. */
	memset(ble_result.data + 4, 0, sizeof(ble_result.data) - 4);
}

void ef_control_ble_get(uint8_t out[EF_BLE_CONTROL_SIZE])
{
	encode(&ble_result, out, EF_BLE_CONTROL_SIZE - 5);
}

void ef_control_tick(int64_t now_ms)
{
	if (ef_stage_tick(&stage, now_ms)) {
		ef_wifi_test_cancel();
	}
}

void ef_control_test_joined(int64_t now_ms)
{
	ef_stage_mark_tested(&stage, now_ms);
}

void ef_control_stage_status(uint8_t *flags, uint8_t *staged_state)
{
	ef_stage_status(&stage, flags, staged_state);
}
