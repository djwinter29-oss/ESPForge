#include "unity.h"
#include "wireless_stage.h"

#include <string.h>

static zf_stage_t stage;
static uint8_t args[64];
static const uint8_t saved_ssid[] = {'h', 'o', 'm', 'e'};
static zf_saved_network_t saved = {sizeof(saved_ssid), saved_ssid, "saved-password"};

void setUp(void)
{
	zf_stage_reset(&stage);
	memset(args, 0, sizeof(args));
}

void tearDown(void)
{
}

static const uint8_t *value(const char *text)
{
	memset(args, 0, sizeof(args));
	args[0] = (uint8_t)strlen(text);
	memcpy(args + 1, text, args[0]);
	return args;
}

void test_argument_checks(void)
{
	memset(args, 'a', sizeof(args));
	args[0] = 33;
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_SSID_LENGTH, zf_stage_check_ssid(args));
	args[0] = 32;
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_ssid(args));
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PASSWORD, zf_stage_check_password(value("short")));
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_password(value("")));
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_password(value("password")));
	value("password");
	args[3] = 0x7F;
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PASSWORD, zf_stage_check_password(args));
	args[0] = 31;
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_KEY_LENGTH, zf_stage_check_key(args));
	args[0] = 32;
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_key(args));
}

void test_new_ssid_requires_password(void)
{
	zf_candidate_t candidate;

	zf_stage_ssid(&stage, value("lab"), 0);
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PAIR_INCOMPLETE, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PAIR_INCOMPLETE, zf_stage_check_commit(&stage, &saved));
	zf_stage_password(&stage, value("password"), 1);
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(3, candidate.ssid_length);
	TEST_ASSERT_EQUAL_MEMORY("lab", candidate.ssid, 3);
	TEST_ASSERT_EQUAL_STRING("password", candidate.password);
	TEST_ASSERT_EQUAL_HEX8(ZF_COMMIT_SSID | ZF_COMMIT_PASSWORD, zf_stage_commit_mask(&stage));
}

void test_password_only_uses_saved_ssid(void)
{
	zf_candidate_t candidate;

	zf_stage_password(&stage, value("newpassword"), 0);
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_PTR(saved_ssid, candidate.ssid);
	saved.ssid_length = 0;
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PAIR_INCOMPLETE, zf_stage_test_candidate(&stage, &saved, &candidate));
	saved.ssid_length = sizeof(saved_ssid);
}

void test_same_ssid_keeps_saved_password(void)
{
	zf_candidate_t candidate;

	zf_stage_ssid(&stage, value("home"), 0);
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_STRING("saved-password", candidate.password);
}

void test_empty_ssid_forgets_network_but_is_not_testable(void)
{
	zf_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	zf_stage_ssid(&stage, value(""), 0);
	zf_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGE_FLAG_SSID | ZF_STAGE_FLAG_PASSWORD, flags);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGED_EMPTY_SSID | ZF_STAGED_EMPTY_PASSWORD, staged_state);
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_PAIR_INCOMPLETE, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_commit(&stage, &saved));
}

void test_key_only_commit_and_clear_key(void)
{
	zf_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	zf_stage_key(&stage, value(""), 0);
	TEST_ASSERT_TRUE(stage.key_clear);
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_NOTHING_STAGED, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(0, zf_stage_check_commit(&stage, &saved));
	TEST_ASSERT_EQUAL_HEX8(ZF_COMMIT_KEY, zf_stage_commit_mask(&stage));
	zf_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGE_FLAG_KEY, flags);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGED_EMPTY_KEY, staged_state);
}

void test_expiry_and_refresh(void)
{
	zf_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_NOTHING_STAGED, zf_stage_check_commit(&stage, &saved));
	zf_stage_password(&stage, value("password"), 0);
	TEST_ASSERT_FALSE(zf_stage_tick(&stage, ZF_STAGE_LIFETIME_MS - 1));
	zf_stage_mark_tested(&stage, 1000);
	TEST_ASSERT_FALSE(zf_stage_tick(&stage, ZF_STAGE_LIFETIME_MS + 999));
	zf_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGE_FLAG_PASSWORD | ZF_STAGE_FLAG_TESTED, flags);
	TEST_ASSERT_TRUE(zf_stage_tick(&stage, ZF_STAGE_LIFETIME_MS + 1000));
	TEST_ASSERT_FALSE(zf_stage_active(&stage));
	zf_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(0, flags);
	TEST_ASSERT_EQUAL_HEX8(ZF_STAGED_EXPIRED, staged_state);
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_EXPIRED, zf_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(ZF_DETAIL_EXPIRED, zf_stage_check_commit(&stage, &saved));
	zf_stage_ssid(&stage, value("home"), 1);
	TEST_ASSERT_FALSE(stage.expired);
}

void test_restaging_clears_tested_flag(void)
{
	zf_stage_password(&stage, value("password"), 0);
	zf_stage_mark_tested(&stage, 0);
	TEST_ASSERT_TRUE(stage.pair_tested);
	zf_stage_key(&stage, value(""), 1);
	TEST_ASSERT_FALSE(stage.pair_tested);
}
