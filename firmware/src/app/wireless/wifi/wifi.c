/*
 * Wi-Fi station: saved-network join with paced retries, candidate tests and scans (Report 12, opcodes 9-12).
 *
 * Uses the ESP32-S3 Wi-Fi driver through Zephyr net_mgmt. Driver events are queued by the callback and applied in
 * ef_wifi_poll(); net_mgmt requests are issued from the poll without holding the application lock.
 */
#include "app/espforge.h"
#include "platform/boot_config.h"
#include "app/control/control.h"
#include "platform/ef_platform.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>

LOG_MODULE_REGISTER(ef_wifi, LOG_LEVEL_INF);

#define CONNECT_TIMEOUT_MS 30000
#define RETRY_DELAY_MS 5000
#define RETRY_MAX_MS 60000
#define LEAVE_TIMEOUT_MS 5000
#define SCAN_TIMEOUT_MS 10000
#define SCAN_MAX 18u

#define STATE_OFF 0u
#define STATE_CONNECTING 1u
#define STATE_CONNECTED 2u
#define STATE_FAILED 3u

#define DETAIL_NONE 0u
#define DETAIL_RADIO 1u
#define DETAIL_TIMEOUT 5u
#define DETAIL_LINK_LOST 6u

#define SECURITY_PRIVACY 0x01u
#define SECURITY_WPA 0x02u
#define SECURITY_RSN 0x04u

#define EVENT_MASK                                                                                            \
	(NET_EVENT_WIFI_CONNECT_RESULT | NET_EVENT_WIFI_DISCONNECT_RESULT | NET_EVENT_WIFI_SCAN_RESULT |         \
	 NET_EVENT_WIFI_SCAN_DONE)

enum link {
	LINK_DOWN,
	LINK_CONNECTING,
	LINK_UP,
	LINK_LEAVING,
};

enum owner {
	OWNER_NONE,
	OWNER_SAVED,
	OWNER_TEST,
};

enum command {
	COMMAND_IDLE,
	COMMAND_TESTING,
	COMMAND_JOINED,
	COMMAND_FAILED,
};

enum action {
	ACTION_NONE,
	ACTION_DISCONNECT,
	ACTION_CONNECT,
	ACTION_SCAN,
};

enum event {
	EVENT_UP,
	EVENT_DOWN_CONNECTED,
	EVENT_DOWN_CONNECTING,
	EVENT_SCAN_DONE,
};

struct network {
	uint8_t ssid[EF_SSID_MAX];
	uint8_t ssid_length;
	char password[EF_WIFI_PASSWORD_SIZE];
};

struct scan_entry {
	uint8_t ssid[EF_SSID_MAX];
	uint8_t ssid_length;
	int8_t rssi;
	uint8_t security;
};

K_MSGQ_DEFINE(events, sizeof(uint8_t), 16, 1);

static struct net_mgmt_event_callback event_cb;
static struct net_if *iface;

static bool saved_enabled;
static struct network saved;
static uint8_t wifi_state;
static uint8_t saved_detail;
static int64_t retry_at;
static int64_t retry_delay = RETRY_DELAY_MS;

static enum link link;
static enum owner owner;
static bool leave_requested;
static int64_t connect_deadline;
static int64_t leave_deadline;

static enum command command;
static uint8_t join_detail;
static struct network test;
static bool test_join_pending;
static uint8_t test_generation;

static uint8_t scan_state;
static uint16_t scan_generation;
static bool scan_pending;
static int64_t scan_deadline;
static uint8_t scan_count;
static struct scan_entry scan[SCAN_MAX];

static void schedule_retry(int64_t now)
{
	retry_at = now + retry_delay;
	retry_delay = MIN(retry_delay * 2, RETRY_MAX_MS);
}

/* Drop the current link; its disconnect event is then ignored as an expected leave. */
static void release_link(void)
{
	owner = OWNER_NONE;
	if (link != LINK_DOWN && link != LINK_LEAVING) {
		leave_requested = true;
	}
}

static void wipe(struct network *network)
{
	memset(network, 0, sizeof(*network));
}

static void fail_test(uint8_t detail, int64_t now)
{
	command = COMMAND_FAILED;
	join_detail = detail;
	test_join_pending = false;
	memset(test.password, 0, sizeof(test.password));
	release_link();
	retry_delay = RETRY_DELAY_MS;
	retry_at = now;
	wifi_state = saved_enabled ? STATE_CONNECTING : STATE_OFF;
	LOG_WRN("Wi-Fi test failed (detail %u)", detail);
}

static void saved_failed(uint8_t detail, int64_t now)
{
	owner = OWNER_NONE;
	wifi_state = STATE_FAILED;
	saved_detail = detail;
	schedule_retry(now);
}

static void link_up(int64_t now)
{
	if (link == LINK_LEAVING) {
		return;
	}
	link = LINK_UP;
	if (owner == OWNER_TEST && command == COMMAND_TESTING) {
		command = COMMAND_JOINED;
		join_detail = DETAIL_NONE;
		ef_control_test_joined(now);
		LOG_INF("Wi-Fi test joined");
	} else if (owner == OWNER_SAVED) {
		wifi_state = STATE_CONNECTED;
		saved_detail = DETAIL_NONE;
		retry_delay = RETRY_DELAY_MS;
		LOG_INF("Wi-Fi connected");
	} else {
		leave_requested = true;
	}
}

static void link_down(int64_t now)
{
	enum link previous = link;

	link = LINK_DOWN;
	if (previous == LINK_LEAVING) {
		return;
	}
	if (owner == OWNER_TEST) {
		owner = OWNER_NONE;
		if (command == COMMAND_JOINED) {
			command = COMMAND_FAILED;
			join_detail = DETAIL_LINK_LOST;
			wifi_state = saved_enabled ? STATE_FAILED : STATE_OFF;
			schedule_retry(now);
			LOG_WRN("Test Wi-Fi link lost");
		} else if (command == COMMAND_TESTING) {
			/* The ESP32 driver does not report why a join failed, so not-found and bad-password share detail 0. */
			fail_test(DETAIL_NONE, now);
		}
	} else if (owner == OWNER_SAVED) {
		saved_failed(DETAIL_NONE, now);
		LOG_WRN("Wi-Fi link down");
	}
}

static void finish_scan(void)
{
	if (scan_state != EF_SCAN_RUNNING) {
		return;
	}
	for (uint8_t i = 1; i < scan_count; ++i) {
		struct scan_entry entry = scan[i];
		uint8_t j = i;

		for (; j > 0 && scan[j - 1].rssi < entry.rssi; --j) {
			scan[j] = scan[j - 1];
		}
		scan[j] = entry;
	}
	scan_state = EF_SCAN_COMPLETE;
}

static uint8_t security_bits(enum wifi_security_type security)
{
	switch (security) {
	case WIFI_SECURITY_TYPE_NONE:
		return 0;
	case WIFI_SECURITY_TYPE_WEP:
		return SECURITY_PRIVACY;
	case WIFI_SECURITY_TYPE_WPA_PSK:
		return SECURITY_PRIVACY | SECURITY_WPA;
	case WIFI_SECURITY_TYPE_PSK:
	case WIFI_SECURITY_TYPE_SAE:
	case WIFI_SECURITY_TYPE_EAP:
		return SECURITY_PRIVACY | SECURITY_RSN;
	default:
		return SECURITY_PRIVACY;
	}
}

/* Keep the strongest result per SSID and the strongest SCAN_MAX SSIDs overall. */
static void add_scan_result(const struct wifi_scan_result *result)
{
	uint8_t length = MIN(result->ssid_length, EF_SSID_MAX);
	struct scan_entry *slot = NULL;

	if (scan_state != EF_SCAN_RUNNING || length == 0) {
		return;
	}
	for (uint8_t i = 0; i < scan_count; ++i) {
		if (scan[i].ssid_length == length && memcmp(scan[i].ssid, result->ssid, length) == 0) {
			if (result->rssi <= scan[i].rssi) {
				return;
			}
			slot = &scan[i];
			break;
		}
	}
	if (slot == NULL && scan_count < SCAN_MAX) {
		slot = &scan[scan_count++];
	}
	if (slot == NULL) {
		slot = &scan[0];
		for (uint8_t i = 1; i < scan_count; ++i) {
			if (scan[i].rssi < slot->rssi) {
				slot = &scan[i];
			}
		}
		if (result->rssi <= slot->rssi) {
			return;
		}
	}
	memset(slot, 0, sizeof(*slot));
	memcpy(slot->ssid, result->ssid, length);
	slot->ssid_length = length;
	slot->rssi = (int8_t)CLAMP(result->rssi, INT8_MIN, INT8_MAX);
	slot->security = security_bits(result->security);
}

static void post(uint8_t event)
{
	if (k_msgq_put(&events, &event, K_NO_WAIT) != 0) {
		LOG_ERR("Wi-Fi event queue full");
	}
}

static void event_handler(struct net_mgmt_event_callback *cb, uint64_t mgmt_event, struct net_if *event_iface)
{
	const struct wifi_status *status = cb->info;

	ARG_UNUSED(event_iface);
	switch (mgmt_event) {
	case NET_EVENT_WIFI_CONNECT_RESULT:
		/* Failed connects are followed by a disconnect event; success is raised after DHCP binds. */
		if (status != NULL && status->status == 0) {
			post(EVENT_UP);
		}
		break;
	case NET_EVENT_WIFI_DISCONNECT_RESULT:
		post(status != NULL && status->status == 0 ? EVENT_DOWN_CONNECTED : EVENT_DOWN_CONNECTING);
		break;
	case NET_EVENT_WIFI_SCAN_RESULT:
		if (cb->info != NULL && cb->info_length >= sizeof(struct wifi_scan_result)) {
			ef_lock();
			add_scan_result(cb->info);
			ef_unlock();
		}
		break;
	case NET_EVENT_WIFI_SCAN_DONE:
		post(EVENT_SCAN_DONE);
		break;
	default:
		break;
	}
}

static void apply_events(int64_t now)
{
	uint8_t event;

	while (k_msgq_get(&events, &event, K_NO_WAIT) == 0) {
		switch (event) {
		case EVENT_UP:
			link_up(now);
			break;
		case EVENT_DOWN_CONNECTED:
		case EVENT_DOWN_CONNECTING:
			link_down(now);
			break;
		case EVENT_SCAN_DONE:
			finish_scan();
			break;
		default:
			break;
		}
	}
}

static void apply_timeouts(int64_t now)
{
	if (link == LINK_LEAVING && now >= leave_deadline) {
		LOG_WRN("Wi-Fi disconnect not confirmed");
		link = LINK_DOWN;
	}
	if (link == LINK_CONNECTING && now >= connect_deadline) {
		if (owner == OWNER_TEST && command == COMMAND_TESTING) {
			fail_test(DETAIL_TIMEOUT, now);
		} else if (owner == OWNER_SAVED) {
			saved_failed(DETAIL_TIMEOUT, now);
			leave_requested = true;
			LOG_WRN("Wi-Fi connect timed out");
		}
	}
	if (scan_state == EF_SCAN_RUNNING && !scan_pending && now >= scan_deadline) {
		scan_state = EF_SCAN_FAILED;
		scan_count = 0;
		LOG_WRN("Wi-Fi scan timed out");
	}
}

static void start_connect(enum owner next, int64_t now)
{
	owner = next;
	link = LINK_CONNECTING;
	connect_deadline = now + CONNECT_TIMEOUT_MS;
}

static enum action next_action(int64_t now, struct network *network)
{
	if (link == LINK_LEAVING) {
		return ACTION_NONE;
	}
	if (leave_requested) {
		leave_requested = false;
		if (link != LINK_DOWN) {
			link = LINK_LEAVING;
			leave_deadline = now + LEAVE_TIMEOUT_MS;
			return ACTION_DISCONNECT;
		}
	}
	if (scan_pending) {
		if (link == LINK_CONNECTING && owner == OWNER_SAVED) {
			/* A join in progress blocks scanning; resume the saved network once the scan ends. */
			owner = OWNER_NONE;
			retry_at = now;
			link = LINK_LEAVING;
			leave_deadline = now + LEAVE_TIMEOUT_MS;
			return ACTION_DISCONNECT;
		}
		scan_pending = false;
		scan_deadline = now + SCAN_TIMEOUT_MS;
		return ACTION_SCAN;
	}
	if (test_join_pending) {
		if (link != LINK_DOWN) {
			owner = OWNER_NONE;
			link = LINK_LEAVING;
			leave_deadline = now + LEAVE_TIMEOUT_MS;
			return ACTION_DISCONNECT;
		}
		test_join_pending = false;
		start_connect(OWNER_TEST, now);
		*network = test;
		return ACTION_CONNECT;
	}
	if (saved_enabled && iface != NULL && owner == OWNER_NONE && link == LINK_DOWN &&
	    command != COMMAND_TESTING && command != COMMAND_JOINED && scan_state != EF_SCAN_RUNNING && retry_at != 0 &&
	    now >= retry_at) {
		retry_at = 0;
		wifi_state = STATE_CONNECTING;
		start_connect(OWNER_SAVED, now);
		*network = saved;
		return ACTION_CONNECT;
	}
	return ACTION_NONE;
}

static int connect(const struct network *network)
{
	struct wifi_connect_req_params params = {
		.ssid = network->ssid,
		.ssid_length = network->ssid_length,
		.psk = (const uint8_t *)network->password,
		.psk_length = (uint8_t)strlen(network->password),
		.security = network->password[0] ? WIFI_SECURITY_TYPE_PSK : WIFI_SECURITY_TYPE_NONE,
		.channel = WIFI_CHANNEL_ANY,
		.band = WIFI_FREQ_BAND_2_4_GHZ,
		.mfp = WIFI_MFP_OPTIONAL,
		.timeout = SYS_FOREVER_MS,
	};

	return net_mgmt(NET_REQUEST_WIFI_CONNECT, iface, &params, sizeof(params));
}

void ef_wifi_poll(void)
{
	int64_t now = k_uptime_get();
	struct network network;
	enum action action;
	int err = 0;

	ef_lock();
	apply_events(now);
	apply_timeouts(now);
	action = iface != NULL ? next_action(now, &network) : ACTION_NONE;
	ef_unlock();

	switch (action) {
	case ACTION_DISCONNECT:
		err = net_mgmt(NET_REQUEST_WIFI_DISCONNECT, iface, NULL, 0);
		break;
	case ACTION_CONNECT:
		err = connect(&network);
		memset(&network, 0, sizeof(network));
		break;
	case ACTION_SCAN:
		err = net_mgmt(NET_REQUEST_WIFI_SCAN, iface, NULL, 0);
		break;
	default:
		return;
	}
	if (err == 0) {
		return;
	}

	LOG_ERR("Wi-Fi request %d failed: %d", action, err);
	ef_lock();
	if (action == ACTION_DISCONNECT) {
		link = LINK_DOWN;
	} else if (action == ACTION_CONNECT) {
		link = LINK_DOWN;
		if (owner == OWNER_TEST && command == COMMAND_TESTING) {
			fail_test(DETAIL_TIMEOUT, now);
		} else if (owner == OWNER_SAVED) {
			saved_failed(DETAIL_NONE, now);
		}
	} else if (scan_state == EF_SCAN_RUNNING) {
		scan_state = EF_SCAN_FAILED;
		scan_count = 0;
	}
	ef_unlock();
}

void ef_wifi_init(bool enabled)
{
	ef_lock();
	saved.ssid_length = ef_boot_config_wifi_ssid_bytes(saved.ssid);
	ef_boot_config_wifi_password(saved.password);
	saved_enabled = enabled && saved.ssid_length != 0;
	iface = net_if_get_first_wifi();
	if (iface == NULL) {
		wifi_state = enabled ? STATE_FAILED : STATE_OFF;
		saved_detail = enabled ? DETAIL_RADIO : DETAIL_NONE;
		ef_unlock();
		LOG_ERR("No Wi-Fi interface");
		return;
	}
	net_mgmt_init_event_callback(&event_cb, event_handler, EVENT_MASK);
	net_mgmt_add_event_callback(&event_cb);
	if (saved_enabled) {
		wifi_state = STATE_CONNECTING;
		retry_at = k_uptime_get();
	}
	ef_unlock();
}

bool ef_wifi_test_active(void)
{
	return command == COMMAND_TESTING;
}

bool ef_wifi_scan_active(void)
{
	return scan_state == EF_SCAN_RUNNING;
}

int ef_wifi_test_start(const uint8_t *ssid, uint8_t ssid_length, const char *password)
{
	if (++test_generation == 0) {
		++test_generation;
	}
	wipe(&test);
	memcpy(test.ssid, ssid, MIN(ssid_length, EF_SSID_MAX));
	test.ssid_length = MIN(ssid_length, EF_SSID_MAX);
	strncpy(test.password, password, sizeof(test.password) - 1);
	if (iface == NULL) {
		command = COMMAND_FAILED;
		join_detail = DETAIL_RADIO;
		memset(test.password, 0, sizeof(test.password));
		return -ENODEV;
	}
	command = COMMAND_TESTING;
	join_detail = DETAIL_NONE;
	test_join_pending = true;
	retry_at = 0;
	connect_deadline = k_uptime_get() + CONNECT_TIMEOUT_MS;
	return 0;
}

void ef_wifi_test_cancel(void)
{
	command = COMMAND_IDLE;
	test_join_pending = false;
	wipe(&test);
	if (owner == OWNER_TEST || (owner == OWNER_NONE && link != LINK_DOWN)) {
		release_link();
	}
	if (owner == OWNER_NONE) {
		wifi_state = saved_enabled ? STATE_CONNECTING : STATE_OFF;
		retry_delay = RETRY_DELAY_MS;
		retry_at = saved_enabled ? k_uptime_get() : 0;
	}
}

int ef_wifi_scan_start(void)
{
	if (iface == NULL) {
		return -ENODEV;
	}
	if (++scan_generation == 0) {
		++scan_generation;
	}
	memset(scan, 0, sizeof(scan));
	scan_count = 0;
	scan_state = EF_SCAN_RUNNING;
	scan_pending = true;
	scan_deadline = k_uptime_get() + SCAN_TIMEOUT_MS;
	return 0;
}

uint8_t ef_wifi_scan_state(void)
{
	return scan_state;
}

uint16_t ef_wifi_scan_generation(void)
{
	return scan_generation;
}

uint8_t ef_wifi_scan_count(void)
{
	return scan_state == EF_SCAN_COMPLETE ? scan_count : 0;
}

int ef_wifi_scan_entry(uint8_t index, uint8_t *ssid, uint8_t *ssid_length, int8_t *rssi, uint8_t *security)
{
	if (scan_state != EF_SCAN_COMPLETE || index >= scan_count) {
		return -EINVAL;
	}
	memcpy(ssid, scan[index].ssid, EF_SSID_MAX);
	*ssid_length = scan[index].ssid_length;
	*rssi = scan[index].rssi;
	*security = scan[index].security;
	return 0;
}

static void ipv4_address(uint8_t out[4])
{
	const struct in_addr *address = net_if_ipv4_get_global_addr(iface, NET_ADDR_PREFERRED);

	if (address != NULL) {
		memcpy(out, address->s4_addr, 4);
	}
}

void ef_wireless_report(uint8_t out[EF_WIRELESS_SIZE])
{
	ef_wireless_t status = {0};
	const struct network *shown;
	uint8_t stage_flags = 0;

	ef_lock();
	switch (command) {
	case COMMAND_TESTING:
		status.wifi_state = 4;
		break;
	case COMMAND_JOINED:
		status.wifi_state = 5;
		break;
	case COMMAND_FAILED:
		status.wifi_state = 6;
		status.detail = join_detail;
		break;
	default:
		status.wifi_state = wifi_state;
		status.detail = saved_detail != DETAIL_NONE ? saved_detail : ef_ble_failed() ? DETAIL_RADIO : DETAIL_NONE;
		break;
	}
	status.ble_state = ef_ble_state();
	ef_control_stage_status(&stage_flags, &status.staged_state);
	status.flags = (uint8_t)((saved.ssid_length ? 0x01u : 0u) | (ef_boot_config_ble_key_configured() ? 0x02u : 0u) |
				 (stage_flags & 0xF0u));
	if (link == LINK_UP && iface != NULL) {
		ipv4_address(status.ipv4);
	}
	shown = test.ssid_length ? &test : &saved;
	status.ssid_length = shown->ssid_length;
	memcpy(status.ssid, shown->ssid, shown->ssid_length);
	status.scan_state = scan_state;
	status.scan_generation = scan_generation;
	status.scan_count = ef_wifi_scan_count();
	status.test_generation = test_generation;
	ef_unlock();
	ef_report_wireless(&status, out);
}
