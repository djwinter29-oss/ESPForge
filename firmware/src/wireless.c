#include "espforge.h"
#include "credentials.h"

#include <errno.h>
#include <string.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/kernel.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/dhcpv4.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>

static int wifi_error = -ENODEV;
static int ble_error = -EAGAIN;
static int connected;
static struct net_if *wifi_iface;
static struct net_mgmt_event_callback wifi_callback;
static char network_ssid[33];
static char network_psk[65];
K_MUTEX_DEFINE(radio_lock);

#define SERVICE_UUID BT_UUID_128_ENCODE(0x7a9c0001, 0x6d8e, 0x4c21, 0xa120, 0x455350464f52)
#define STATUS_UUID BT_UUID_128_ENCODE(0x7a9c0002, 0x6d8e, 0x4c21, 0xa120, 0x455350464f52)
static struct bt_uuid_128 service_uuid = BT_UUID_INIT_128(SERVICE_UUID);
static struct bt_uuid_128 status_uuid = BT_UUID_INIT_128(STATUS_UUID);

static ssize_t read_status(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	static char json[ESPFORGE_STATUS_SIZE];
	static int size;

	if (offset == 0) {
		size = status_json(json, sizeof(json));
	}
	if (size < 0) {
		return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
	}
	return bt_gatt_attr_read(conn, attr, buf, len, offset, json, size);
}

BT_GATT_SERVICE_DEFINE(espforge_service,
	BT_GATT_PRIMARY_SERVICE(&service_uuid),
	BT_GATT_CHARACTERISTIC(&status_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_status, NULL, NULL));

static const struct bt_data advertising[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, SERVICE_UUID),
};

static const struct bt_data scan_response[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static void advertise(struct k_work *work)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, advertising,
				 ARRAY_SIZE(advertising), scan_response,
				 ARRAY_SIZE(scan_response));

	k_mutex_lock(&radio_lock, K_FOREVER);
	ble_error = err;
	k_mutex_unlock(&radio_lock);
}

K_WORK_DEFINE(advertise_work, advertise);

static void connection_recycled(void)
{
	k_work_submit(&advertise_work);
}

BT_CONN_CB_DEFINE(connection_callbacks) = {
	.recycled = connection_recycled,
};

static void wifi_event(struct net_mgmt_event_callback *cb, uint64_t event,
		       struct net_if *iface)
{
	if (iface != wifi_iface) {
		return;
	}
	k_mutex_lock(&radio_lock, K_FOREVER);
	if (event == NET_EVENT_WIFI_CONNECT_RESULT) {
		const struct wifi_status *result = cb->info;

		wifi_error = result ? result->status : -EIO;
		connected = wifi_error == 0;
	} else if (event == NET_EVENT_WIFI_DISCONNECT_RESULT) {
		connected = 0;
		wifi_error = -ENOTCONN;
	}
	k_mutex_unlock(&radio_lock);
}

void wireless_init(void)
{
	wifi_iface = net_if_get_first_wifi();
	if (wifi_iface) {
		net_mgmt_init_event_callback(&wifi_callback, wifi_event,
			NET_EVENT_WIFI_CONNECT_RESULT | NET_EVENT_WIFI_DISCONNECT_RESULT);
		net_mgmt_add_event_callback(&wifi_callback);
		wifi_error = net_if_up(wifi_iface);
		if (wifi_error == -EALREADY) {
			wifi_error = 0;
		}
		net_dhcpv4_start(wifi_iface);
	}

	ble_error = bt_enable(NULL);
	if (ble_error == 0) {
		advertise(NULL);
	}
}

int wireless_connect(const char *ssid, const char *psk)
{
	int err = credentials_validate(ssid, psk);

	if (err) {
		return err;
	}
	size_t ssid_len = strlen(ssid);
	size_t psk_len = strlen(psk);
	if (!wifi_iface) {
		return -ENODEV;
	}
	k_mutex_lock(&radio_lock, K_FOREVER);
	if (connected || wifi_error == -EINPROGRESS) {
		k_mutex_unlock(&radio_lock);
		return -EALREADY;
	}
	memcpy(network_ssid, ssid, ssid_len + 1);
	memcpy(network_psk, psk, psk_len + 1);
	struct wifi_connect_req_params params = {
		.ssid = (const uint8_t *)network_ssid,
		.ssid_length = ssid_len,
		.psk = (const uint8_t *)network_psk,
		.psk_length = psk_len,
		.channel = WIFI_CHANNEL_ANY,
		.security = psk_len ? WIFI_SECURITY_TYPE_PSK : WIFI_SECURITY_TYPE_NONE,
		.band = WIFI_FREQ_BAND_2_4_GHZ,
		.mfp = WIFI_MFP_OPTIONAL,
		.timeout = 20,
	};
	wifi_error = -EINPROGRESS;
	k_mutex_unlock(&radio_lock);
	err = net_mgmt(NET_REQUEST_WIFI_CONNECT, wifi_iface, &params, sizeof(params));
	if (err) {
		k_mutex_lock(&radio_lock, K_FOREVER);
		wifi_error = err;
		k_mutex_unlock(&radio_lock);
	}
	return err;
}

void wireless_status(int *wifi_result, int *ble_result, int *is_connected)
{
	k_mutex_lock(&radio_lock, K_FOREVER);
	*wifi_result = wifi_error;
	*ble_result = ble_error;
	*is_connected = connected;
	k_mutex_unlock(&radio_lock);
}
