#include "unity.h"
#include "wireless_stage.h"

#include <string.h>

static ef_stage_t stage;
static uint8_t args[64];
static const uint8_t saved_ssid[] = {'h', 'o', 'm', 'e'};
static ef_saved_network_t saved = {sizeof(saved_ssid), saved_ssid, "saved-password"};

void setUp(void)
{
	ef_stage_reset(&stage);
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
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_SSID_LENGTH, ef_stage_check_ssid(args));
	args[0] = 32;
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_ssid(args));
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PASSWORD, ef_stage_check_password(value("short")));
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_password(value("")));
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_password(value("password")));
	value("password");
	args[3] = 0x7F;
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PASSWORD, ef_stage_check_password(args));
	args[0] = 31;
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_KEY_LENGTH, ef_stage_check_key(args));
	args[0] = 32;
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_key(args));
}

void test_new_ssid_requires_password(void)
{
	ef_candidate_t candidate;

	ef_stage_ssid(&stage, value("lab"), 0);
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PAIR_INCOMPLETE, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PAIR_INCOMPLETE, ef_stage_check_commit(&stage, &saved));
	ef_stage_password(&stage, value("password"), 1);
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(3, candidate.ssid_length);
	TEST_ASSERT_EQUAL_MEMORY("lab", candidate.ssid, 3);
	TEST_ASSERT_EQUAL_STRING("password", candidate.password);
	TEST_ASSERT_EQUAL_HEX8(EF_COMMIT_SSID | EF_COMMIT_PASSWORD, ef_stage_commit_mask(&stage));
}

void test_password_only_uses_saved_ssid(void)
{
	ef_candidate_t candidate;

	ef_stage_password(&stage, value("newpassword"), 0);
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_PTR(saved_ssid, candidate.ssid);
	saved.ssid_length = 0;
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PAIR_INCOMPLETE, ef_stage_test_candidate(&stage, &saved, &candidate));
	saved.ssid_length = sizeof(saved_ssid);
}

void test_same_ssid_keeps_saved_password(void)
{
	ef_candidate_t candidate;

	ef_stage_ssid(&stage, value("home"), 0);
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_STRING("saved-password", candidate.password);
}

void test_empty_ssid_forgets_network_but_is_not_testable(void)
{
	ef_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	ef_stage_ssid(&stage, value(""), 0);
	ef_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGE_FLAG_SSID | EF_STAGE_FLAG_PASSWORD, flags);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGED_EMPTY_SSID | EF_STAGED_EMPTY_PASSWORD, staged_state);
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_PAIR_INCOMPLETE, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_commit(&stage, &saved));
}

void test_key_only_commit_and_clear_key(void)
{
	ef_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	ef_stage_key(&stage, value(""), 0);
	TEST_ASSERT_TRUE(stage.key_clear);
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_NOTHING_STAGED, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(0, ef_stage_check_commit(&stage, &saved));
	TEST_ASSERT_EQUAL_HEX8(EF_COMMIT_KEY, ef_stage_commit_mask(&stage));
	ef_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGE_FLAG_KEY, flags);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGED_EMPTY_KEY, staged_state);
}

void test_expiry_and_refresh(void)
{
	ef_candidate_t candidate;
	uint8_t flags;
	uint8_t staged_state;

	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_NOTHING_STAGED, ef_stage_check_commit(&stage, &saved));
	ef_stage_password(&stage, value("password"), 0);
	TEST_ASSERT_FALSE(ef_stage_tick(&stage, EF_STAGE_LIFETIME_MS - 1));
	ef_stage_mark_tested(&stage, 1000);
	TEST_ASSERT_FALSE(ef_stage_tick(&stage, EF_STAGE_LIFETIME_MS + 999));
	ef_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGE_FLAG_PASSWORD | EF_STAGE_FLAG_TESTED, flags);
	TEST_ASSERT_TRUE(ef_stage_tick(&stage, EF_STAGE_LIFETIME_MS + 1000));
	TEST_ASSERT_FALSE(ef_stage_active(&stage));
	ef_stage_status(&stage, &flags, &staged_state);
	TEST_ASSERT_EQUAL_HEX8(0, flags);
	TEST_ASSERT_EQUAL_HEX8(EF_STAGED_EXPIRED, staged_state);
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_EXPIRED, ef_stage_test_candidate(&stage, &saved, &candidate));
	TEST_ASSERT_EQUAL_UINT8(EF_DETAIL_EXPIRED, ef_stage_check_commit(&stage, &saved));
	ef_stage_ssid(&stage, value("home"), 1);
	TEST_ASSERT_FALSE(stage.expired);
}

void test_restaging_clears_tested_flag(void)
{
	ef_stage_password(&stage, value("password"), 0);
	ef_stage_mark_tested(&stage, 0);
	TEST_ASSERT_TRUE(stage.pair_tested);
	ef_stage_key(&stage, value(""), 1);
	TEST_ASSERT_FALSE(stage.pair_tested);
}
