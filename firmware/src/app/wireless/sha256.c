#include "app/wireless/sha256.h"

#include <string.h>

static const uint32_t k[64] = {
	0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
	0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
	0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
	0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
	0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
	0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
	0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
	0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static uint32_t rotr(uint32_t value, unsigned bits)
{
	return (value >> bits) | (value << (32u - bits));
}

static void compress(ef_sha256_t *ctx, const uint8_t block[EF_SHA256_BLOCK_SIZE])
{
	uint32_t w[64];
	uint32_t v[8];

	for (unsigned i = 0; i < 16; ++i) {
		w[i] = (uint32_t)block[4 * i] << 24 | (uint32_t)block[4 * i + 1] << 16 |
		       (uint32_t)block[4 * i + 2] << 8 | block[4 * i + 3];
	}
	for (unsigned i = 16; i < 64; ++i) {
		uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
		uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);

		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	memcpy(v, ctx->state, sizeof(v));
	for (unsigned i = 0; i < 64; ++i) {
		uint32_t s1 = rotr(v[4], 6) ^ rotr(v[4], 11) ^ rotr(v[4], 25);
		uint32_t ch = (v[4] & v[5]) ^ (~v[4] & v[6]);
		uint32_t t1 = v[7] + s1 + ch + k[i] + w[i];
		uint32_t s0 = rotr(v[0], 2) ^ rotr(v[0], 13) ^ rotr(v[0], 22);
		uint32_t maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);

		memmove(&v[1], &v[0], 7 * sizeof(v[0]));
		v[4] += t1;
		v[0] = t1 + s0 + maj;
	}
	for (unsigned i = 0; i < 8; ++i) {
		ctx->state[i] += v[i];
	}
	memset(w, 0, sizeof(w));
}

void ef_sha256_init(ef_sha256_t *ctx)
{
	static const uint32_t initial[8] = {
		0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
		0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
	};

	memcpy(ctx->state, initial, sizeof(initial));
	ctx->length = 0;
	ctx->used = 0;
}

void ef_sha256_update(ef_sha256_t *ctx, const uint8_t *data, size_t size)
{
	ctx->length += size;
	while (size) {
		size_t take = EF_SHA256_BLOCK_SIZE - ctx->used;

		if (take > size) {
			take = size;
		}
		memcpy(ctx->block + ctx->used, data, take);
		ctx->used += take;
		data += take;
		size -= take;
		if (ctx->used == EF_SHA256_BLOCK_SIZE) {
			compress(ctx, ctx->block);
			ctx->used = 0;
		}
	}
}

void ef_sha256_final(ef_sha256_t *ctx, uint8_t digest[EF_SHA256_SIZE])
{
	uint64_t bits = ctx->length * 8u;
	uint8_t pad = 0x80;

	ef_sha256_update(ctx, &pad, 1);
	pad = 0;
	while (ctx->used != EF_SHA256_BLOCK_SIZE - 8u) {
		ef_sha256_update(ctx, &pad, 1);
	}
	for (int shift = 56; shift >= 0; shift -= 8) {
		ctx->block[ctx->used++] = (uint8_t)(bits >> shift);
	}
	compress(ctx, ctx->block);
	for (unsigned i = 0; i < 8; ++i) {
		digest[4 * i] = (uint8_t)(ctx->state[i] >> 24);
		digest[4 * i + 1] = (uint8_t)(ctx->state[i] >> 16);
		digest[4 * i + 2] = (uint8_t)(ctx->state[i] >> 8);
		digest[4 * i + 3] = (uint8_t)ctx->state[i];
	}
	memset(ctx, 0, sizeof(*ctx));
}

void ef_hmac_sha256(const uint8_t *key, size_t key_size, const ef_hmac_part_t *parts, size_t count,
		    uint8_t mac[EF_SHA256_SIZE])
{
	uint8_t pad[EF_SHA256_BLOCK_SIZE] = {0};
	uint8_t inner[EF_SHA256_SIZE];
	ef_sha256_t ctx;

	if (key_size > EF_SHA256_BLOCK_SIZE) {
		ef_sha256_init(&ctx);
		ef_sha256_update(&ctx, key, key_size);
		ef_sha256_final(&ctx, pad);
	} else if (key_size) {
		memcpy(pad, key, key_size);
	}
	for (unsigned i = 0; i < sizeof(pad); ++i) {
		pad[i] ^= 0x36u;
	}
	ef_sha256_init(&ctx);
	ef_sha256_update(&ctx, pad, sizeof(pad));
	for (size_t i = 0; i < count; ++i) {
		ef_sha256_update(&ctx, parts[i].data, parts[i].size);
	}
	ef_sha256_final(&ctx, inner);
	for (unsigned i = 0; i < sizeof(pad); ++i) {
		pad[i] ^= 0x36u ^ 0x5cu;
	}
	ef_sha256_init(&ctx);
	ef_sha256_update(&ctx, pad, sizeof(pad));
	ef_sha256_update(&ctx, inner, sizeof(inner));
	ef_sha256_final(&ctx, mac);
	memset(pad, 0, sizeof(pad));
	memset(inner, 0, sizeof(inner));
}
