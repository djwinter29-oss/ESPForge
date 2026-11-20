/**
 * @file sha256.h
 * @brief Portable SHA-256 and HMAC-SHA256 used by the Bluetooth LE command proofs.
 */
#ifndef ZEPHYRFORGE_SHA256_H
#define ZEPHYRFORGE_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define ZF_SHA256_SIZE 32u
#define ZF_SHA256_BLOCK_SIZE 64u

typedef struct {
	uint32_t state[8];
	uint64_t length;
	uint8_t block[ZF_SHA256_BLOCK_SIZE];
	size_t used;
} zf_sha256_t;

void zf_sha256_init(zf_sha256_t *ctx);
void zf_sha256_update(zf_sha256_t *ctx, const uint8_t *data, size_t size);
void zf_sha256_final(zf_sha256_t *ctx, uint8_t digest[ZF_SHA256_SIZE]);

/** One message part for zf_hmac_sha256(); the MAC covers all parts concatenated in order. */
typedef struct {
	const uint8_t *data;
	size_t size;
} zf_hmac_part_t;

void zf_hmac_sha256(const uint8_t *key, size_t key_size, const zf_hmac_part_t *parts, size_t count,
		    uint8_t mac[ZF_SHA256_SIZE]);

#endif
