#include "credentials.h"

#include <errno.h>
#include <string.h>

static int hex_digit(char digit)
{
	if (digit >= '0' && digit <= '9') {
		return digit - '0';
	}
	if (digit >= 'a' && digit <= 'f') {
		return digit - 'a' + 10;
	}
	if (digit >= 'A' && digit <= 'F') {
		return digit - 'A' + 10;
	}
	return -1;
}

int credential_decode(const char *hex, char *output, size_t capacity)
{
	if (!hex || !output || capacity == 0) {
		return -EINVAL;
	}
	size_t length = strlen(hex);
	size_t bytes = length / 2;

	if (length % 2 || bytes >= capacity) {
		return -EINVAL;
	}
	for (size_t i = 0; i < bytes; ++i) {
		int high = hex_digit(hex[i * 2]);
		int low = hex_digit(hex[i * 2 + 1]);

		if (high < 0 || low < 0 || (high == 0 && low == 0)) {
			return -EINVAL;
		}
		output[i] = (char)((high << 4) | low);
	}
	output[bytes] = '\0';
	return 0;
}

int credentials_validate(const char *ssid, const char *psk)
{
	if (!ssid || !psk) {
		return -EINVAL;
	}
	size_t ssid_len = strlen(ssid);
	size_t psk_len = strlen(psk);

	return ssid_len == 0 || ssid_len > 32 ||
	       (psk_len != 0 && (psk_len < 8 || psk_len > 63)) ? -EINVAL : 0;
}
