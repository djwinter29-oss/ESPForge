#include "espforge.h"
#include "credentials.h"

#include <errno.h>
#include <string.h>
#include <zephyr/data/json.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zephyr/sys/printk.h>

struct request {
	int id;
	char *op;
	char *ssid_hex;
	char *psk_hex;
};

static const struct json_obj_descr fields[] = {
	JSON_OBJ_DESCR_PRIM(struct request, id, JSON_TOK_NUMBER),
	JSON_OBJ_DESCR_PRIM(struct request, op, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM(struct request, ssid_hex, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM(struct request, psk_hex, JSON_TOK_STRING),
};
static const struct device *serial = DEVICE_DT_GET(DT_NODELABEL(uart0));

static void send_line(const char *text)
{
	while (*text) {
		uart_poll_out(serial, *text++);
	}
	uart_poll_out(serial, '\n');
}

static void respond(char *line, size_t length)
{
	struct request request = {0};
	char output[ESPFORGE_STATUS_SIZE + 96];
	int64_t parsed = json_obj_parse(line, length, fields, ARRAY_SIZE(fields), &request);
	int err = 0;
	int id = parsed >= 0 && (parsed & BIT(0)) ? request.id : 0;

	if (parsed < 0 || (parsed & 3) != 3 || id <= 0) {
		err = -EINVAL;
	} else if (strcmp(request.op, "status") == 0) {
		char status[ESPFORGE_STATUS_SIZE];
		err = status_json(status, sizeof(status));
		if (err >= 0) {
			snprintk(output, sizeof(output),
				"{\"id\":%d,\"ok\":true,\"status\":%s}", id, status);
			send_line(output);
			return;
		}
	} else if (strcmp(request.op, "wifi.connect") == 0) {
		char ssid[33], psk[64];

		err = -EINVAL;
		if ((parsed & 12) == 12 &&
		    credential_decode(request.ssid_hex, ssid, sizeof(ssid)) == 0 &&
		    credential_decode(request.psk_hex, psk, sizeof(psk)) == 0) {
			err = wireless_connect(ssid, psk);
		}
		memset(psk, 0, sizeof(psk));
	} else {
		err = -ENOTSUP;
	}
	snprintk(output, sizeof(output), "{\"id\":%d,\"ok\":%s,\"error\":%d}",
		 id, err == 0 ? "true" : "false", err);
	send_line(output);
}

int main(void)
{
	static char line[ESPFORGE_REQUEST_SIZE];
	size_t used = 0;
	bool overflow = false;

	if (!device_is_ready(serial)) {
		return -ENODEV;
	}
	wireless_init();
	storage_init();
	for (;;) {
		unsigned char byte;
		if (uart_poll_in(serial, &byte) != 0) {
			k_sleep(K_MSEC(1));
			continue;
		}
		if (byte == '\n') {
			if (overflow) {
				send_line("{\"id\":0,\"ok\":false,\"error\":-90}");
			} else if (used) {
				line[used] = '\0';
				respond(line, used);
			}
			used = 0;
			overflow = false;
		} else if (byte != '\r') {
			if (used < sizeof(line) - 1 && !overflow) {
				line[used++] = byte;
			} else {
				overflow = true;
			}
		}
	}
}
