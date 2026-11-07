#include "status_format.h"
#include "espforge.h"

#include <errno.h>
#include <stdio.h>

int status_format(char *buffer, size_t size, int64_t uptime_ms)
{
	if (!buffer && size != 0) {
		return -EINVAL;
	}
	int wifi_error, ble_error, connected;
	int sd_result = storage_error();

	wireless_status(&wifi_error, &ble_error, &connected);
	int count = snprintf(buffer, size,
		"{\"protocol\":1,\"product\":\"ESPForge\",\"board\":\"ESP32-S3-DevKitC\","
		"\"firmware\":\"" ESPFORGE_VERSION "\",\"uptime_ms\":%lld,"
		"\"wifi_enabled\":true,\"ble_enabled\":true,\"wifi_connected\":%s,"
		"\"wifi_error\":%d,\"ble_error\":%d,\"sd_mounted\":%s,\"sd_error\":%d}",
		(long long)uptime_ms, connected ? "true" : "false",
		wifi_error, ble_error, sd_result == 0 ? "true" : "false",
		sd_result);

	return count < 0 || (size_t)count >= size ? -ENOSPC : count;
}
