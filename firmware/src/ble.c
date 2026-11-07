/*
 * Bluetooth LE peripheral: report mirrors, session unlock, command proofs and the 9-byte control characteristic
 * (docs/reference/bluetooth.md with the docs/reference/espforge-profile.md adaptations).
 */
#include "espforge.h"
#include "boot_config.h"
#include "control.h"
#include "wireless_auth.h"

#include <stdio.h>
#include <string.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>

LOG_MODULE_REGISTER(ef_ble, LOG_LEVEL_INF);

#define FAST_INTERVAL 96   /* 60 ms */
#define SLOW_INTERVAL 800  /* 500 ms */
#define FAST_PERIOD_MS 30000

#define CHR_IDENTITY 0x0001u
#define CHR_CONFIG 0x0002u
#define CHR_TELEMETRY 0x0003u
#define CHR_STORAGE 0x000Au
#define CHR_BENCHMARK 0x000Bu
#define CHR_WIRELESS 0x000Cu
#define CHR_CONTROL 0x0014u
#define CHR_NONCE 0x0100u
#define CHR_PROOF 0x0101u

#define EF_UUID(suffix) BT_UUID_128_ENCODE(0xef5c0000u | (suffix), 0x7c91, 0x4d70, 0x8b32, 0x6e856443f502)
#define EF_UUID_DECLARE(suffix) BT_UUID_DECLARE_128(EF_UUID(suffix))

#define NAME_SIZE (sizeof("ESPForge-") - 1 + 2 * EF_UID_SIZE)
#define SNAPSHOT_SIZE EF_WIRELESS_SIZE

static atomic_t state = ATOMIC_INIT(EF_BLE_OFF);
static bool failed;
static bool slow;
static struct bt_conn *current;
static char name[NAME_SIZE + 1];
static char firmware_revision[] = ESPFORGE_VERSION;

/* Session state for the single connection; guarded by ef_lock(). */
static ef_auth_session_t session;
static const struct bt_gatt_attr *snapshot_attr;
static uint8_t snapshot[SNAPSHOT_SIZE];
static uint16_t snapshot_length;
static uint8_t sequence;

static const struct bt_data advertising[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, EF_UUID(0x0000u)),
};

static struct bt_data scan_response[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, name, NAME_SIZE),
};

static void slow_down(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(slow_work, slow_down);

static int advertise(bool fast)
{
	uint16_t interval = fast ? FAST_INTERVAL : SLOW_INTERVAL;
	struct bt_le_adv_param param = BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONN, interval, interval, NULL);
	int err = bt_le_adv_start(&param, advertising, ARRAY_SIZE(advertising), scan_response,
				  ARRAY_SIZE(scan_response));

	if (err == 0) {
		atomic_set(&state, EF_BLE_ADVERTISING);
		slow = !fast;
		if (fast) {
			(void)k_work_reschedule(&slow_work, K_MSEC(FAST_PERIOD_MS));
		}
	} else {
		LOG_ERR("Advertising failed: %d", err);
	}
	return err;
}

static void slow_down(struct k_work *work)
{
	ARG_UNUSED(work);
	if (atomic_get(&state) == EF_BLE_ADVERTISING && !slow && bt_le_adv_stop() == 0) {
		(void)advertise(false);
	}
}

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err != 0) {
		return;
	}
	(void)k_work_cancel_delayable(&slow_work);
	ef_lock();
	current = bt_conn_ref(conn);
	ef_auth_session_reset(&session);
	snapshot_attr = NULL;
	ef_unlock();
	atomic_set(&state, EF_BLE_CONNECTED);
	LOG_INF("Central connected");
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	ef_lock();
	if (current == conn) {
		bt_conn_unref(current);
		current = NULL;
	}
	ef_auth_session_reset(&session);
	snapshot_attr = NULL;
	ef_unlock();
	atomic_set(&state, EF_BLE_OFF);
	LOG_INF("Central disconnected (0x%02x)", reason);
}

/* The connection object is free again, so connectable advertising can restart. */
static void recycled(void)
{
	if (atomic_get(&state) == EF_BLE_OFF && !failed && name[0] != '\0') {
		(void)advertise(true);
	}
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
	.recycled = recycled,
};

static uint16_t build(uint16_t chr, uint8_t *out)
{
	switch (chr) {
	case CHR_IDENTITY:
		ef_identity_report(out);
		return EF_IDENTITY_SIZE;
	case CHR_CONFIG:
		ef_config_report(out);
		return EF_CONFIG_SIZE;
	case CHR_TELEMETRY:
		ef_telemetry_report(++sequence, out);
		return EF_TELEMETRY_SIZE;
	case CHR_STORAGE:
		ef_storage_report(++sequence, out);
		return EF_STORAGE_SIZE;
	case CHR_BENCHMARK:
		/* No benchmark: the value is empty, but the read still advances the BLE sequence. */
		++sequence;
		return 0;
	case CHR_WIRELESS:
		ef_wireless_report(out);
		return EF_WIRELESS_SIZE;
	case CHR_CONTROL:
		ef_control_ble_get(out);
		return EF_BLE_CONTROL_SIZE;
	case CHR_NONCE:
		if (sys_csrand_get(out, EF_AUTH_NONCE_SIZE) != 0) {
			return 0;
		}
		ef_auth_set_nonce(&session, out);
		return EF_AUTH_NONCE_SIZE;
	default:
		return 0;
	}
}

static bool open_while_locked(uint16_t chr)
{
	return chr == CHR_IDENTITY || chr == CHR_NONCE;
}

static ssize_t read_report(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf, uint16_t len,
			   uint16_t offset)
{
	uint16_t chr = (uint16_t)POINTER_TO_UINT(attr->user_data);
	ssize_t result;

	ARG_UNUSED(conn);
	ef_lock();
	if (!session.unlocked && !open_while_locked(chr)) {
		result = BT_GATT_ERR(EF_ATT_ERR_REJECTED);
	} else if (offset == 0) {
		snapshot_length = build(chr, snapshot);
		snapshot_attr = attr;
		result = MIN(len, snapshot_length);
		memcpy(buf, snapshot, result);
	} else if (snapshot_attr != attr || offset > snapshot_length) {
		result = BT_GATT_ERR(EF_ATT_ERR_INVALID_OFFSET);
	} else {
		result = MIN(len, snapshot_length - offset);
		memcpy(buf, snapshot + offset, result);
	}
	ef_unlock();
	return result;
}

static ssize_t write_proof(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf, uint16_t len,
			   uint16_t offset, uint8_t flags)
{
	uint8_t err;

	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	if (offset != 0 || (flags & (BT_GATT_WRITE_FLAG_PREPARE | BT_GATT_WRITE_FLAG_CMD))) {
		return BT_GATT_ERR(BT_ATT_ERR_NOT_SUPPORTED);
	}
	ef_lock();
	err = ef_auth_write_proof(&session, buf, len, k_uptime_get());
	ef_unlock();
	return err ? BT_GATT_ERR(err) : len;
}

static ssize_t write_control(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf, uint16_t len,
			     uint16_t offset, uint8_t flags)
{
	const uint8_t *request = buf;
	int64_t now = k_uptime_get();
	ssize_t result = len;

	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	if (offset != 0 || (flags & (BT_GATT_WRITE_FLAG_PREPARE | BT_GATT_WRITE_FLAG_CMD))) {
		return BT_GATT_ERR(BT_ATT_ERR_NOT_SUPPORTED);
	}
	ef_lock();
	if (!session.unlocked) {
		result = BT_GATT_ERR(EF_ATT_ERR_REJECTED);
	} else if (!ef_control_ble_envelope(request, len)) {
		result = BT_GATT_ERR(EF_ATT_ERR_ENVELOPE);
	} else {
		uint8_t err = request[2] == EF_OP_LED ? 0 : ef_auth_authorize(&session, request, len, now);

		if (err) {
			result = BT_GATT_ERR(err);
		} else {
			ef_control_ble_execute(request, now);
		}
	}
	ef_unlock();
	return result;
}

static ssize_t read_text(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf, uint16_t len,
			 uint16_t offset)
{
	const char *text = attr->user_data;

	return bt_gatt_attr_read(conn, attr, buf, len, offset, text, strlen(text));
}

#define REPORT_CHR(suffix)                                                                                    \
	BT_GATT_CHARACTERISTIC(EF_UUID_DECLARE(suffix), BT_GATT_CHRC_READ, BT_GATT_PERM_READ, read_report, NULL,     \
			       UINT_TO_POINTER(suffix))

BT_GATT_SERVICE_DEFINE(espforge_service,
	BT_GATT_PRIMARY_SERVICE(EF_UUID_DECLARE(0x0000u)),
	REPORT_CHR(CHR_IDENTITY),
	REPORT_CHR(CHR_CONFIG),
	REPORT_CHR(CHR_TELEMETRY),
	REPORT_CHR(CHR_STORAGE),
	REPORT_CHR(CHR_BENCHMARK),
	REPORT_CHR(CHR_WIRELESS),
	BT_GATT_CHARACTERISTIC(EF_UUID_DECLARE(CHR_CONTROL), BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_READ | BT_GATT_PERM_WRITE, read_report, write_control,
			       UINT_TO_POINTER(CHR_CONTROL)),
	REPORT_CHR(CHR_NONCE),
	BT_GATT_CHARACTERISTIC(EF_UUID_DECLARE(CHR_PROOF), BT_GATT_CHRC_WRITE, BT_GATT_PERM_WRITE, NULL, write_proof,
			       NULL));

BT_GATT_SERVICE_DEFINE(device_information,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DIS),
	BT_GATT_CHARACTERISTIC(BT_UUID_DIS_MANUFACTURER_NAME, BT_GATT_CHRC_READ, BT_GATT_PERM_READ, read_text, NULL,
			       "ESPForge"),
	BT_GATT_CHARACTERISTIC(BT_UUID_DIS_FIRMWARE_REVISION, BT_GATT_CHRC_READ, BT_GATT_PERM_READ, read_text, NULL,
			       firmware_revision));

void ef_ble_init(bool enabled)
{
	uint8_t key[EF_BLE_KEY_SIZE];
	int err;

	if (!enabled) {
		return;
	}
	ef_lock();
	if (!ef_boot_config_ble_key_configured()) {
		ef_unlock();
		LOG_WRN("Bluetooth is enabled but no Control key is saved; Bluetooth stays off");
		return;
	}
	ef_boot_config_ble_key(key);
	ef_auth_init(key, ef_board_uid());
	memset(key, 0, sizeof(key));
	ef_auth_session_reset(&session);
	ef_unlock();

	err = bt_enable(NULL);
	if (err == 0) {
		(void)snprintf(name, sizeof(name), "ESPForge-%s", ef_board_serial());
		err = bt_set_name(name);
	}
	if (err == 0) {
		err = advertise(true);
	}
	if (err != 0) {
		failed = true;
		LOG_ERR("Bluetooth start failed: %d", err);
	}
}

uint8_t ef_ble_state(void)
{
	return (uint8_t)atomic_get(&state);
}

bool ef_ble_failed(void)
{
	return failed;
}
