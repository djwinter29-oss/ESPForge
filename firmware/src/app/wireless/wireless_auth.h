/**
 * @file wireless_auth.h
 * @brief Bluetooth LE session unlock and per-command proofs (docs/reference/bluetooth.md).
 *
 * Portable state machine: the Zephyr glue supplies time, random challenges and the saved Control key. Results are
 * ATT error codes (0 when accepted). The retry delay is global across connections; the session is per connection.
 */
#ifndef ESPFORGE_WIRELESS_AUTH_H
#define ESPFORGE_WIRELESS_AUTH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define EF_AUTH_KEY_SIZE 32u
#define EF_AUTH_NONCE_SIZE 16u
#define EF_AUTH_PROOF_SIZE 16u
#define EF_AUTH_UID_SIZE 8u
#define EF_AUTH_RETRY_DELAY_MS 2000

#define EF_ATT_ERR_INVALID_OFFSET 0x07u
#define EF_ATT_ERR_INVALID_LENGTH 0x0Du
#define EF_ATT_ERR_REJECTED 0x80u
#define EF_ATT_ERR_ENVELOPE 0x81u
#define EF_ATT_ERR_RATE_LIMITED 0x82u
#define EF_ATT_ERR_UNAVAILABLE 0x83u

typedef struct {
	bool unlocked;
	bool nonce_valid;
	bool proof_staged;
	uint8_t nonce[EF_AUTH_NONCE_SIZE];
	uint8_t proof[EF_AUTH_PROOF_SIZE];
} ef_auth_session_t;

/** First 16 bytes of HMAC-SHA256(key, nonce || uid || "PFBLECTL1" || request). */
void ef_auth_proof(const uint8_t key[EF_AUTH_KEY_SIZE], const uint8_t nonce[EF_AUTH_NONCE_SIZE],
		   const uint8_t uid[EF_AUTH_UID_SIZE], const uint8_t *request, size_t request_size,
		   uint8_t proof[EF_AUTH_PROOF_SIZE]);

/** Load the Control key and board UID; a NULL key leaves proofs unavailable. Resets the retry delay. */
void ef_auth_init(const uint8_t key[EF_AUTH_KEY_SIZE], const uint8_t uid[EF_AUTH_UID_SIZE]);

/** Clear a connection's unlock, challenge and proof (connect and disconnect). */
void ef_auth_session_reset(ef_auth_session_t *session);

/** Install a fresh challenge read from characteristic 0100; invalidates any staged proof. */
void ef_auth_set_nonce(ef_auth_session_t *session, const uint8_t nonce[EF_AUTH_NONCE_SIZE]);

/** Handle a 0101 Write Request. Unlocks a locked session when the session proof matches. */
uint8_t ef_auth_write_proof(ef_auth_session_t *session, const uint8_t *data, size_t size, int64_t now_ms);

/** Authorize one valid-envelope, non-LED control request on an unlocked session; consumes the proof. */
uint8_t ef_auth_authorize(ef_auth_session_t *session, const uint8_t *request, size_t size, int64_t now_ms);

#endif
