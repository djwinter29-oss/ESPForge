/**
 * @file sha256.h
 * @brief Portable SHA-256 and HMAC-SHA256 used by the Bluetooth LE command proofs.
 */
#ifndef ESPFORGE_SHA256_H
#define ESPFORGE_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define EF_SHA256_SIZE 32u
#define EF_SHA256_BLOCK_SIZE 64u

typedef struct {
	uint32_t state[8];
	uint64_t length;
	uint8_t block[EF_SHA256_BLOCK_SIZE];
	size_t used;
} ef_sha256_t;

void ef_sha256_init(ef_sha256_t *ctx);
void ef_sha256_update(ef_sha256_t *ctx, const uint8_t *data, size_t size);
void ef_sha256_final(ef_sha256_t *ctx, uint8_t digest[EF_SHA256_SIZE]);

/** One message part for ef_hmac_sha256(); the MAC covers all parts concatenated in order. */
typedef struct {
	const uint8_t *data;
	size_t size;
} ef_hmac_part_t;

void ef_hmac_sha256(const uint8_t *key, size_t key_size, const ef_hmac_part_t *parts, size_t count,
		    uint8_t mac[EF_SHA256_SIZE]);

#endif
