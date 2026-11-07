#include "unity.h"
#include "credentials.h"

#include <errno.h>
#include <string.h>

void setUp(void)
{
}

void tearDown(void)
{
}

void test_decode_accepts_uppercase_and_lowercase_hex(void)
{
	char output[5];

	TEST_ASSERT_EQUAL_INT(0, credential_decode("4e6574C3", output, sizeof(output)));
	const unsigned char expected[] = {'N', 'e', 't', 0xc3, 0};
	TEST_ASSERT_EQUAL_MEMORY(expected, output, sizeof(expected));
}

void test_decode_accepts_empty_password(void)
{
	char output[1] = {'x'};

	TEST_ASSERT_EQUAL_INT(0, credential_decode("", output, sizeof(output)));
	TEST_ASSERT_EQUAL_STRING("", output);
}

void test_decode_rejects_odd_hex_length(void)
{
	char output[3];

	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("414", output, sizeof(output)));
}

void test_decode_rejects_non_hex_in_either_nibble(void)
{
	char output[3];

	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("x1", output, sizeof(output)));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("1x", output, sizeof(output)));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode(" 1", output, sizeof(output)));
}

void test_decode_rejects_embedded_null(void)
{
	char output[4];

	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("410042", output, sizeof(output)));
}

void test_decode_reserves_space_for_terminator(void)
{
	char output[3] = {'x', 'x', 'x'};

	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("4142", output, 2));
	TEST_ASSERT_EQUAL_CHAR('x', output[2]);
	TEST_ASSERT_EQUAL_INT(0, credential_decode("4142", output, sizeof(output)));
	TEST_ASSERT_EQUAL_STRING("AB", output);
}

void test_decode_rejects_invalid_buffers(void)
{
	char output[2];

	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode(NULL, output, sizeof(output)));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("41", NULL, 2));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credential_decode("", output, 0));
}

void test_validate_accepts_open_network_and_minimum_password(void)
{
	TEST_ASSERT_EQUAL_INT(0, credentials_validate("N", ""));
	TEST_ASSERT_EQUAL_INT(0, credentials_validate("Network", "12345678"));
}

void test_validate_rejects_empty_and_oversized_ssid(void)
{
	char ssid[34];
	memset(ssid, 's', sizeof(ssid) - 1);
	ssid[33] = '\0';

	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate("", ""));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate(ssid, ""));
	ssid[32] = '\0';
	TEST_ASSERT_EQUAL_INT(0, credentials_validate(ssid, ""));
}

void test_validate_password_boundaries(void)
{
	char psk[65];
	memset(psk, 'p', sizeof(psk) - 1);
	psk[64] = '\0';

	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate("Network", "1234567"));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate("Network", psk));
	psk[63] = '\0';
	TEST_ASSERT_EQUAL_INT(0, credentials_validate("Network", psk));
}

void test_validate_counts_utf8_bytes_not_characters(void)
{
	char ssid[35];
	for (size_t i = 0; i < 34; i += 2) {
		ssid[i] = (char)0xc3;
		ssid[i + 1] = (char)0xa9;
	}
	ssid[34] = '\0';

	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate(ssid, ""));
	ssid[32] = '\0';
	TEST_ASSERT_EQUAL_INT(0, credentials_validate(ssid, ""));
}

void test_validate_rejects_null_credentials(void)
{
	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate(NULL, ""));
	TEST_ASSERT_EQUAL_INT(-EINVAL, credentials_validate("Network", NULL));
}
