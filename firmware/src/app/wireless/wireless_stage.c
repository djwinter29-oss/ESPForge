#include "app/wireless/wireless_stage.h"

#include <string.h>

void ef_stage_reset(ef_stage_t *stage)
{
	memset(stage, 0, sizeof(*stage));
}

bool ef_stage_active(const ef_stage_t *stage)
{
	return stage->ssid_staged || stage->password_staged || stage->key_staged;
}

static void touch(ef_stage_t *stage, int64_t now_ms)
{
	stage->expired = false;
	stage->pair_tested = false;
	stage->deadline_ms = now_ms + EF_STAGE_LIFETIME_MS;
}

uint8_t ef_stage_check_ssid(const uint8_t *args)
{
	if (args[0] > EF_STAGE_SSID_MAX) {
		return EF_DETAIL_SSID_LENGTH;
	}
	return 0;
}

uint8_t ef_stage_check_password(const uint8_t *args)
{
	uint8_t length = args[0];

	if (length > EF_STAGE_PASSWORD_MAX || (length && length < 8)) {
		return EF_DETAIL_PASSWORD;
	}
	for (uint8_t i = 1; i <= length; ++i) {
		if (args[i] < 0x20 || args[i] > 0x7E) {
			return EF_DETAIL_PASSWORD;
		}
	}
	return 0;
}

uint8_t ef_stage_check_key(const uint8_t *args)
{
	return args[0] == 0 || args[0] == EF_STAGE_KEY_SIZE ? 0 : EF_DETAIL_KEY_LENGTH;
}

void ef_stage_ssid(ef_stage_t *stage, const uint8_t *args, int64_t now_ms)
{
	if (!ef_stage_active(stage)) {
		ef_stage_reset(stage);
	}
	memset(stage->ssid, 0, sizeof(stage->ssid));
	stage->ssid_length = args[0];
	memcpy(stage->ssid, args + 1, args[0]);
	stage->ssid_staged = true;
	if (args[0] == 0) {
		/* Forgetting the network implicitly stages an empty password. */
		memset(stage->password, 0, sizeof(stage->password));
		stage->password_length = 0;
		stage->password_staged = true;
	}
	touch(stage, now_ms);
}

void ef_stage_password(ef_stage_t *stage, const uint8_t *args, int64_t now_ms)
{
	if (!ef_stage_active(stage)) {
		ef_stage_reset(stage);
	}
	memset(stage->password, 0, sizeof(stage->password));
	stage->password_length = args[0];
	memcpy(stage->password, args + 1, args[0]);
	stage->password_staged = true;
	touch(stage, now_ms);
}

void ef_stage_key(ef_stage_t *stage, const uint8_t *args, int64_t now_ms)
{
	if (!ef_stage_active(stage)) {
		ef_stage_reset(stage);
	}
	memset(stage->key, 0, sizeof(stage->key));
	stage->key_clear = args[0] == 0;
	if (!stage->key_clear) {
		memcpy(stage->key, args + 1, EF_STAGE_KEY_SIZE);
	}
	stage->key_staged = true;
	touch(stage, now_ms);
}

bool ef_stage_tick(ef_stage_t *stage, int64_t now_ms)
{
	if (!ef_stage_active(stage) || now_ms < stage->deadline_ms) {
		return false;
	}
	ef_stage_reset(stage);
	stage->expired = true;
	return true;
}

static bool same_ssid(const ef_stage_t *stage, const ef_saved_network_t *saved)
{
	return stage->ssid_length == saved->ssid_length && memcmp(stage->ssid, saved->ssid, saved->ssid_length) == 0;
}

/* Shared pair rules: never combine a new SSID with the saved password. */
static uint8_t check_pair(const ef_stage_t *stage, const ef_saved_network_t *saved)
{
	if (stage->ssid_staged && stage->ssid_length && !stage->password_staged && !same_ssid(stage, saved)) {
		return EF_DETAIL_PAIR_INCOMPLETE;
	}
	if (!stage->ssid_staged && stage->password_staged && saved->ssid_length == 0) {
		return EF_DETAIL_PAIR_INCOMPLETE;
	}
	return 0;
}

uint8_t ef_stage_test_candidate(const ef_stage_t *stage, const ef_saved_network_t *saved, ef_candidate_t *candidate)
{
	uint8_t detail;

	if (stage->expired) {
		return EF_DETAIL_EXPIRED;
	}
	if (!stage->ssid_staged && !stage->password_staged) {
		return EF_DETAIL_NOTHING_STAGED;
	}
	if (stage->ssid_staged && stage->ssid_length == 0) {
		return EF_DETAIL_PAIR_INCOMPLETE;
	}
	detail = check_pair(stage, saved);
	if (detail) {
		return detail;
	}
	if (stage->ssid_staged) {
		candidate->ssid_length = stage->ssid_length;
		candidate->ssid = stage->ssid;
	} else {
		candidate->ssid_length = saved->ssid_length;
		candidate->ssid = saved->ssid;
	}
	candidate->password = stage->password_staged ? stage->password : saved->password;
	return 0;
}

uint8_t ef_stage_check_commit(const ef_stage_t *stage, const ef_saved_network_t *saved)
{
	if (stage->expired) {
		return EF_DETAIL_EXPIRED;
	}
	if (!ef_stage_active(stage)) {
		return EF_DETAIL_NOTHING_STAGED;
	}
	return check_pair(stage, saved);
}

uint8_t ef_stage_commit_mask(const ef_stage_t *stage)
{
	return (uint8_t)((stage->ssid_staged ? EF_COMMIT_SSID : 0) | (stage->password_staged ? EF_COMMIT_PASSWORD : 0) |
			 (stage->key_staged ? EF_COMMIT_KEY : 0));
}

void ef_stage_mark_tested(ef_stage_t *stage, int64_t now_ms)
{
	if (stage->ssid_staged || stage->password_staged) {
		stage->pair_tested = true;
		stage->deadline_ms = now_ms + EF_STAGE_LIFETIME_MS;
	}
}

void ef_stage_status(const ef_stage_t *stage, uint8_t *flags, uint8_t *staged_state)
{
	*flags = 0;
	*staged_state = 0;
	if (stage->expired) {
		*staged_state = EF_STAGED_EXPIRED;
		return;
	}
	if (stage->ssid_staged) {
		*flags |= EF_STAGE_FLAG_SSID;
		*staged_state |= stage->ssid_length ? 0 : EF_STAGED_EMPTY_SSID;
	}
	if (stage->password_staged) {
		*flags |= EF_STAGE_FLAG_PASSWORD;
		*staged_state |= stage->password_length ? 0 : EF_STAGED_EMPTY_PASSWORD;
	}
	if (stage->key_staged) {
		*flags |= EF_STAGE_FLAG_KEY;
		*staged_state |= stage->key_clear ? EF_STAGED_EMPTY_KEY : 0;
	}
	if (stage->pair_tested) {
		*flags |= EF_STAGE_FLAG_TESTED;
	}
}
