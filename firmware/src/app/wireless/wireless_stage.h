/**
 * @file wireless_stage.h
 * @brief RAM-only staged Wi-Fi/Control-key candidates for USB Feature 20 opcodes 5-10.
 *
 * Handles staging, expiry and test eligibility. Portable: callers pass the monotonic time and the saved network.
 */
#ifndef ESPFORGE_WIRELESS_STAGE_H
#define ESPFORGE_WIRELESS_STAGE_H

#include <stdbool.h>
#include <stdint.h>

#define EF_STAGE_LIFETIME_MS 600000
#define EF_STAGE_SSID_MAX 32u
#define EF_STAGE_PASSWORD_MAX 63u
#define EF_STAGE_KEY_SIZE 32u

/* Feature 20 wireless detail values. */
#define EF_DETAIL_SSID_LENGTH 16u
#define EF_DETAIL_PASSWORD 17u
#define EF_DETAIL_KEY_LENGTH 18u
#define EF_DETAIL_PAIR_INCOMPLETE 19u
#define EF_DETAIL_EXPIRED 20u
#define EF_DETAIL_NOTHING_STAGED 21u

/* Feature 12 flag and staged_state bits owned by staging. */
#define EF_STAGE_FLAG_SSID 0x10u
#define EF_STAGE_FLAG_PASSWORD 0x20u
#define EF_STAGE_FLAG_KEY 0x40u
#define EF_STAGE_FLAG_TESTED 0x80u
#define EF_STAGED_EMPTY_SSID 0x01u
#define EF_STAGED_EMPTY_PASSWORD 0x02u
#define EF_STAGED_EMPTY_KEY 0x04u
#define EF_STAGED_EXPIRED 0x08u

/* Successful opcode 5 commit-mask bits. */
#define EF_COMMIT_SSID 0x01u
#define EF_COMMIT_PASSWORD 0x02u
#define EF_COMMIT_KEY 0x04u

typedef struct {
	bool ssid_staged;
	bool password_staged;
	bool key_staged;
	bool pair_tested;
	bool expired;
	uint8_t ssid_length;
	uint8_t ssid[EF_STAGE_SSID_MAX];
	uint8_t password_length;
	char password[EF_STAGE_PASSWORD_MAX + 1];
	bool key_clear;
	uint8_t key[EF_STAGE_KEY_SIZE];
	int64_t deadline_ms;
} ef_stage_t;

/** The saved network that staged values are compared against. */
typedef struct {
	uint8_t ssid_length;
	const uint8_t *ssid;
	const char *password;
} ef_saved_network_t;

/** A resolved credential pair to test or commit; pointers refer to staged or saved storage. */
typedef struct {
	uint8_t ssid_length;
	const uint8_t *ssid;
	const char *password;
} ef_candidate_t;

void ef_stage_reset(ef_stage_t *stage);
bool ef_stage_active(const ef_stage_t *stage);

/** Stage values; return 0 or an invalid-argument detail. Callers check test-active Busy first. */
uint8_t ef_stage_check_ssid(const uint8_t *args);
uint8_t ef_stage_check_password(const uint8_t *args);
uint8_t ef_stage_check_key(const uint8_t *args);
void ef_stage_ssid(ef_stage_t *stage, const uint8_t *args, int64_t now_ms);
void ef_stage_password(ef_stage_t *stage, const uint8_t *args, int64_t now_ms);
void ef_stage_key(ef_stage_t *stage, const uint8_t *args, int64_t now_ms);

/** Expire unrefreshed values. Returns true when values expired during this call. */
bool ef_stage_tick(ef_stage_t *stage, int64_t now_ms);

/** Resolve the test pair; returns 0 or detail 19-21. */
uint8_t ef_stage_test_candidate(const ef_stage_t *stage, const ef_saved_network_t *saved, ef_candidate_t *candidate);

/** Validate an opcode 5 wireless commit; returns 0 or detail 19-21. */
uint8_t ef_stage_check_commit(const ef_stage_t *stage, const ef_saved_network_t *saved);
uint8_t ef_stage_commit_mask(const ef_stage_t *stage);

/** Record a successful test of the current pair and restart the save window. */
void ef_stage_mark_tested(ef_stage_t *stage, int64_t now_ms);

void ef_stage_status(const ef_stage_t *stage, uint8_t *flags, uint8_t *staged_state);

#endif
