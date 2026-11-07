#include "unity.h"
#include "sha256.h"

#include <string.h>

static void assert_hex(const char *hex, const uint8_t *bytes, size_t size)
{
	char text[2 * EF_SHA256_SIZE + 1];

	for (size_t i = 0; i < size; ++i) {
		static const char digits[] = "0123456789abcdef";
		text[2 * i] = digits[bytes[i] >> 4];
		text[2 * i + 1] = digits[bytes[i] & 0x0F];
	}
	text[2 * size] = '\0';
	TEST_ASSERT_EQUAL_STRING(hex, text);
}

void test_sha256_abc(void)
{
	ef_sha256_t ctx;
	uint8_t digest[EF_SHA256_SIZE];

	ef_sha256_init(&ctx);
	ef_sha256_update(&ctx, (const uint8_t *)"abc", 3);
	ef_sha256_final(&ctx, digest);
	assert_hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", digest, sizeof(digest));
}

void test_sha256_multi_block_split_updates(void)
{
	uint8_t data[1000];
	ef_sha256_t ctx;
	uint8_t digest[EF_SHA256_SIZE];

	memset(data, 'a', sizeof(data));
	ef_sha256_init(&ctx);
	ef_sha256_update(&ctx, data, 7);
	ef_sha256_update(&ctx, data + 7, 600);
	ef_sha256_update(&ctx, data + 607, 393);
	ef_sha256_final(&ctx, digest);
	assert_hex("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3", digest, sizeof(digest));
}

void test_hmac_hashes_long_key_and_joins_parts(void)
{
	uint8_t key[100];
	uint8_t mac[EF_SHA256_SIZE];
	const ef_hmac_part_t parts[] = {{(const uint8_t *)"m", 1}, {(const uint8_t *)"sg", 2}};

	memset(key, 'k', sizeof(key));
	ef_hmac_sha256(key, sizeof(key), parts, 2, mac);
	assert_hex("bd56a1782c2830e8abc6ed866a57a1230661e650b84c62f7ee3accc5fa5af491", mac, sizeof(mac));
}
